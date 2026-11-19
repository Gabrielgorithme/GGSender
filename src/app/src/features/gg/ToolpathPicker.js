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
 *
 * It can also show one part of the toolpath alone (an operation): the
 * toolpath that upstream draws is hidden and a second line draws only that
 * part, from the same vertex and colour buffers. So the colours of a running
 * job (done, planned) stay correct, and nothing of upstream's drawing is
 * changed. While a part is shown alone, a click finds only moves of that part.
 */
import * as THREE from 'three';
import pubsub from 'pubsub-js';

import {
    lineForVertex,
    nearestDrawnLine,
    nearestSegmentOnScreen,
    stepDrawnLine,
    vertexRangeForLine,
    vertexRangeForLineSpan,
} from 'app/lib/gg/toolpathPick';
import {
    ISOLATE_REQUEST,
    PICK_REQUEST,
    publishIsolation,
    publishPick,
} from './pickTopics';

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
        // { key, label, firstLine, endLine, start, end, object, toolpath }
        this.isolation = null;
        this.token = pubsub.subscribe(PICK_REQUEST, (_msg, payload) =>
            this.handleRequest(payload || {}),
        );
        this.isolateToken = pubsub.subscribe(ISOLATE_REQUEST, (_msg, payload) =>
            this.handleIsolate(payload || {}),
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
        this.removeIsolation();
        pubsub.unsubscribe(this.token);
        pubsub.unsubscribe(this.isolateToken);
    }

    /** New toolpath: { frames, frameLines, vertices } (typed arrays). */
    setData(data) {
        this.removeOverlay();
        this.removeIsolation();
        publishIsolation(null);
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
            // only what is shown can be clicked
            this.isolation ? this.isolation.end : undefined,
            this.isolation ? this.isolation.start : 0,
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
            const iso = this.isolation;
            let from = this.line;
            if (from === null || from === undefined) {
                // no line yet: the first or the last move of what is shown
                if (step > 0) {
                    from = iso ? iso.firstLine - 1 : -1;
                } else {
                    from = iso && iso.endLine !== null ? iso.endLine : Number.MAX_SAFE_INTEGER;
                }
            }
            const next = stepDrawnLine(this.data.frames, this.data.frameLines, from, step);
            // a part shown alone: the steps stop at its first and last move
            if (next !== null && (!iso || this.inIsolation(next))) {
                this.select(next);
            }
            return;
        }
        if (Number.isInteger(line) && line >= 0) {
            // a line asked for by number that is not in the part shown alone:
            // show everything again, or the highlight would point at nothing
            if (this.isolation && !this.inIsolation(line)) {
                this.isolate(null);
            }
            this.select(line);
        }
    }

    handleIsolate({ clear, key, label, firstLine, endLine }) {
        if (clear) {
            this.isolate(null);
            return;
        }
        this.isolate({ key, label, firstLine, endLine: endLine ?? null });
    }

    inIsolation(line) {
        const iso = this.isolation;
        return Boolean(iso) && line >= iso.firstLine && (iso.endLine === null || line < iso.endLine);
    }

    /**
     * Show only the moves of the file lines firstLine to endLine (not
     * included; null: to the end), or everything again with null.
     */
    isolate(request) {
        this.removeIsolation();
        const toolpath = this.getToolpath();
        const range =
            request && this.data
                ? vertexRangeForLineSpan(
                      this.data.frames,
                      this.data.frameLines,
                      request.firstLine,
                      request.endLine,
                  )
                : null;
        if (!range || !toolpath || !toolpath.parent) {
            publishIsolation(null);
            this.render();
            return;
        }

        // the same buffers as the toolpath, another part of them drawn
        const geometry = new THREE.BufferGeometry();
        ['position', 'color'].forEach((name) => {
            const attribute = toolpath.geometry.getAttribute(name);
            if (attribute) {
                geometry.setAttribute(name, attribute);
            }
        });
        const object = new THREE.Line(geometry, toolpath.material);
        object.name = 'gg-isolated';
        // the bounding sphere would be that of the whole toolpath: no gain
        object.frustumCulled = false;
        // same transform as the toolpath (rotary files rotate their parent)
        object.matrixAutoUpdate = false;
        object.matrix.copy(toolpath.matrix);
        // added after the toolpath: upstream takes its first child for the toolpath
        toolpath.parent.add(object);
        toolpath.visible = false;

        this.isolation = {
            key: String(request.key ?? ''),
            label: String(request.label ?? ''),
            firstLine: request.firstLine,
            endLine: request.endLine,
            start: range.start,
            end: range.end,
            object,
            toolpath,
        };
        // upstream can hide the lines already run by moving the draw range of
        // the toolpath during a job: follow it at every frame
        object.onBeforeRender = () => this.syncIsolationRange();
        this.syncIsolationRange();

        // a highlight outside of what is shown would point at nothing
        if (this.line !== null && this.line !== undefined && !this.inIsolation(this.line)) {
            this.select(null);
        }
        publishIsolation({
            key: this.isolation.key,
            label: this.isolation.label,
            firstLine: request.firstLine,
            endLine: request.endLine,
        });
        this.render();
    }

    /** Draw the part shown alone, less what upstream hides of the toolpath. */
    syncIsolationRange() {
        const iso = this.isolation;
        if (!iso) {
            return;
        }
        const shown = iso.toolpath.geometry.drawRange || { start: 0, count: Infinity };
        const shownStart = shown.start || 0;
        const from = Math.max(iso.start, shownStart);
        const to = Math.min(iso.end, shownStart + shown.count);
        iso.object.geometry.setDrawRange(from, Math.max(0, to - from));
    }

    removeIsolation() {
        const iso = this.isolation;
        if (!iso) {
            return;
        }
        this.isolation = null;
        iso.toolpath.visible = true;
        if (iso.object.parent) {
            iso.object.parent.remove(iso.object);
        }
        // the buffers and the material belong to the toolpath: let go of them
        // before the dispose, which would free them
        const geometry = iso.object.geometry;
        Object.keys(geometry.attributes).forEach((name) => geometry.deleteAttribute(name));
        geometry.dispose();
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
