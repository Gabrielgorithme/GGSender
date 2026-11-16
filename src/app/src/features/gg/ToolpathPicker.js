/*
 * GGSender addition (not part of upstream gSender).
 *
 * Click on the toolpath in the 3D view to find the G-code line that drew it,
 * and highlight the motion of any line asked for. The line lookups are in
 * lib/gg/toolpathPick.ts; this class handles the mouse, the camera and the
 * highlight drawn over the toolpath.
 *
 * A click is a press and release without moving more than a few pixels, so
 * rotating, panning and zooming the view are unaffected.
 */
import * as THREE from 'three';
import pubsub from 'pubsub-js';

import {
    lineForVertex,
    nearestDrawnLine,
    nearestSegmentOnScreen,
    stepDrawnLine,
    vertexRangeForLine,
} from 'app/lib/gg/toolpathPick';
import { PICK_REQUEST, publishPick } from './pickTopics';

const CLICK_MOVE_TOLERANCE = 4; // px
const CLICK_MAX_DURATION = 700; // ms
const PICK_DISTANCE = 8; // px
const HIGHLIGHT_COLOR = 0xff2bd6;
const START_COLOR = 0xffffff;

export default class ToolpathPicker {
    /**
     * @param getCamera    () => THREE.Camera
     * @param getToolpath  () => THREE.Line | null, the drawn toolpath
     * @param render       () => void, redraw the scene
     */
    constructor({ getCamera, getToolpath, render }) {
        this.getCamera = getCamera;
        this.getToolpath = getToolpath;
        this.render = render;
        this.element = null;
        this.data = null;
        this.overlay = null;
        this.line = null;
        this.down = null;
        this.token = pubsub.subscribe(PICK_REQUEST, (_msg, payload) =>
            this.handleRequest(payload || {}),
        );
    }

    attach(element) {
        this.detach();
        if (!element) {
            return;
        }
        this.element = element;
        element.addEventListener('pointerdown', this.onPointerDown);
        element.addEventListener('pointerup', this.onPointerUp);
    }

    detach() {
        if (this.element) {
            this.element.removeEventListener('pointerdown', this.onPointerDown);
            this.element.removeEventListener('pointerup', this.onPointerUp);
        }
        this.element = null;
    }

    dispose() {
        this.detach();
        this.removeOverlay();
        pubsub.unsubscribe(this.token);
    }

    /** New toolpath: { frames, frameLines, vertices } (typed arrays). */
    setData(data) {
        this.removeOverlay();
        this.line = null;
        const ok =
            data &&
            data.frames &&
            data.frameLines &&
            data.vertices &&
            data.frames.length === data.frameLines.length &&
            data.frameLines.length > 0;
        this.data = ok ? data : null;
        publishPick(null);
    }

    /** Toolpath removed. */
    reset() {
        this.setData(null);
    }

    onPointerDown = (e) => {
        if (e.button !== 0) {
            this.down = null;
            return;
        }
        this.down = { x: e.clientX, y: e.clientY, t: Date.now() };
    };

    onPointerUp = (e) => {
        const down = this.down;
        this.down = null;
        if (!down || e.button !== 0) {
            return;
        }
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        if (moved > CLICK_MOVE_TOLERANCE || Date.now() - down.t > CLICK_MAX_DURATION) {
            return;
        }
        this.pickAt(e.clientX, e.clientY);
    };

    pickAt(clientX, clientY) {
        const toolpath = this.getToolpath();
        const camera = this.getCamera();
        if (!this.data || !toolpath || !camera || !this.element) {
            return;
        }
        const rect = this.element.getBoundingClientRect();
        camera.updateMatrixWorld();
        toolpath.updateMatrixWorld();
        const matrix = new THREE.Matrix4()
            .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
            .multiply(toolpath.matrixWorld);

        const hit = nearestSegmentOnScreen(
            this.data.vertices,
            matrix.elements,
            rect.width,
            rect.height,
            clientX - rect.left,
            clientY - rect.top,
            PICK_DISTANCE,
        );
        if (!hit) {
            this.select(null);
            return;
        }
        this.select(lineForVertex(this.data.frames, this.data.frameLines, hit.vertexIndex));
    }

    handleRequest({ line, step, clear }) {
        if (clear) {
            this.select(null);
            return;
        }
        if (!this.data) {
            return;
        }
        if (step === 1 || step === -1) {
            const from = this.line ?? (step > 0 ? -1 : Number.MAX_SAFE_INTEGER);
            const next = stepDrawnLine(this.data.frames, this.data.frameLines, from, step);
            if (next !== null) {
                this.select(next);
            }
            return;
        }
        if (Number.isInteger(line) && line >= 0) {
            this.select(line);
        }
    }

    /** Highlight a line (0-based) or clear with null. */
    select(line) {
        this.removeOverlay();
        this.line = line;
        if (line === null || line === undefined || !this.data) {
            this.line = null;
            publishPick(null);
            this.render();
            return;
        }

        const { frames, frameLines } = this.data;
        const range = vertexRangeForLine(frames, frameLines, line);
        // a line without motion: show where the machine is at that point
        const shownLine = range ? line : nearestDrawnLine(frames, frameLines, line);
        const shown = shownLine === null ? null : vertexRangeForLine(frames, frameLines, shownLine);

        if (shown) {
            this.addOverlay(shown, Boolean(range));
        }
        publishPick({ line, drew: Boolean(range), shownLine });
        this.render();
    }

    addOverlay({ start, end }, drew) {
        const toolpath = this.getToolpath();
        if (!toolpath || !toolpath.parent) {
            return;
        }
        const v = this.data.vertices;
        const group = new THREE.Group();
        group.name = 'gg-pick';
        group.renderOrder = 999;

        if (drew) {
            const positions = new Float32Array(v.subarray(start * 3, end * 3));
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const material = new THREE.LineBasicMaterial({
                color: HIGHLIGHT_COLOR,
                depthTest: false,
                transparent: true,
            });
            // one continuous line, like the toolpath itself: an arc is a
            // run of points, not pairs
            const lines = new THREE.Line(geometry, material);
            lines.renderOrder = 999;
            group.add(lines);
        }

        // start (white) and end (pink) of the move; for a line without
        // motion only the end of the previous move, where the tool then is
        const points = drew
            ? [
                  [start, START_COLOR, 7],
                  [end - 1, HIGHLIGHT_COLOR, 11],
              ]
            : [[end - 1, HIGHLIGHT_COLOR, 11]];
        points.forEach(([index, color, size]) => {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
                'position',
                new THREE.BufferAttribute(new Float32Array(v.subarray(index * 3, index * 3 + 3)), 3),
            );
            const material = new THREE.PointsMaterial({
                color,
                size,
                sizeAttenuation: false,
                depthTest: false,
                transparent: true,
            });
            const p = new THREE.Points(geometry, material);
            p.renderOrder = 1000;
            group.add(p);
        });

        // same transform as the toolpath (rotary files rotate it)
        group.matrixAutoUpdate = false;
        group.matrix.copy(toolpath.matrix);
        toolpath.parent.add(group);
        this.overlay = group;
    }

    removeOverlay() {
        if (!this.overlay) {
            return;
        }
        this.overlay.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        if (this.overlay.parent) {
            this.overlay.parent.remove(this.overlay);
        }
        this.overlay = null;
    }
}
