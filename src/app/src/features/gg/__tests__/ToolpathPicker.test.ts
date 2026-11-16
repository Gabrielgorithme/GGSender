// @ts-ignore three ships no type declarations in this project
import * as THREE from 'three';
import pubsub from 'pubsub-js';

import ToolpathPicker from '../ToolpathPicker';
import { PICK_CHANGED, getCurrentPick, requestPickClear, requestPickLine, requestPickStep } from '../pickTopics';

/*
 * Two moves seen from straight above with an orthographic camera covering
 * x,y in [-100, 100] on a 200x200 px canvas, so 1 mm = 1 px and
 * screen = (x + 100, 100 - y).
 *   line 3: G1 X-50 Y0 -> X50 Y0     (vertices 0,1)
 *   line 5: G1 X50 Y0 -> X50 Y50     (vertices 2,3)
 */
const setup = () => {
    const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    const vertices = Float32Array.from([-50, 0, 0, 50, 0, 0, 50, 0, 0, 50, 50, 0]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    const toolpath = new THREE.Line(geometry, new THREE.LineBasicMaterial());
    toolpath.name = 'workpiece';
    const group = new THREE.Group();
    group.add(toolpath);

    const element = document.createElement('canvas');
    element.getBoundingClientRect = () =>
        ({ left: 10, top: 20, width: 200, height: 200, right: 210, bottom: 220, x: 10, y: 20, toJSON: () => ({}) }) as DOMRect;

    const render = jest.fn();
    const picker = new ToolpathPicker({ getCamera: () => camera, getToolpath: () => toolpath, render });
    picker.attach(element);
    picker.setData({
        frames: Uint32Array.from([0, 2, 2, 4]),
        frameLines: Uint32Array.from([1, 3, 4, 5]),
        vertices,
    });

    const click = (x: number, y: number, moveBy = 0) => {
        // jsdom has no PointerEvent; MouseEvent carries the same fields
        element.dispatchEvent(new MouseEvent('pointerdown', { clientX: x + 10, clientY: y + 20, button: 0 }));
        element.dispatchEvent(new MouseEvent('pointerup', { clientX: x + 10 + moveBy, clientY: y + 20, button: 0 }));
    };
    const overlay = () => group.getObjectByName('gg-pick');
    return { picker, click, overlay, render, group };
};

// pubsub delivers messages on the next tick
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('GGSender: picking the toolpath in the 3D view', () => {
    let picker: ToolpathPicker | null;
    afterEach(() => {
        picker?.dispose();
        picker = null;
    });

    it('a click on a move selects its line and highlights it', () => {
        const s = setup();
        picker = s.picker;
        const seen = [];
        const token = pubsub.subscribe(PICK_CHANGED, (_m, p) => seen.push(p));
        s.click(120, 102); // near (20, -2) on the first move
        pubsub.unsubscribe(token);
        expect(getCurrentPick()).toEqual({ line: 3, drew: true, shownLine: 3 });
        expect(s.overlay()).toBeTruthy();
        const lines = s.overlay().children.find((c: THREE.Object3D) => c.type === 'Line') as THREE.Line;
        expect(Array.from(lines.geometry.getAttribute('position').array)).toEqual([-50, 0, 0, 50, 0, 0]);
        expect(s.render).toHaveBeenCalled();
    });

    it('picks the second move', () => {
        const s = setup();
        picker = s.picker;
        s.click(152, 75); // near (52, 25)
        expect(getCurrentPick().line).toBe(5);
    });

    it('a drag is not a click', async () => {
        const s = setup();
        picker = s.picker;
        requestPickClear();
        await tick();
        s.click(120, 102, 30);
        expect(getCurrentPick()).toBeNull();
        expect(s.overlay()).toBeUndefined();
    });

    it('a click on empty space clears the selection', () => {
        const s = setup();
        picker = s.picker;
        s.click(120, 102);
        s.click(20, 180);
        expect(getCurrentPick()).toBeNull();
        expect(s.overlay()).toBeUndefined();
    });

    it('shows a line asked for by number, and steps between moves', async () => {
        const s = setup();
        picker = s.picker;
        requestPickLine(5);
        await tick();
        expect(getCurrentPick()).toEqual({ line: 5, drew: true, shownLine: 5 });
        requestPickStep(-1);
        await tick();
        expect(getCurrentPick().line).toBe(3);
        requestPickStep(-1);
        await tick();
        expect(getCurrentPick().line).toBe(3); // no move before
        requestPickStep(1);
        await tick();
        expect(getCurrentPick().line).toBe(5);
    });

    it('for a line without motion, marks where the tool is', async () => {
        const s = setup();
        picker = s.picker;
        requestPickLine(4);
        await tick();
        expect(getCurrentPick()).toEqual({ line: 4, drew: false, shownLine: 3 });
        const children = s.overlay().children;
        expect(children.some((c: THREE.Object3D) => c.type === 'Line')).toBe(false);
        expect(children.filter((c: THREE.Object3D) => c.type === 'Points')).toHaveLength(1);
    });

    it('a new file clears the selection', async () => {
        const s = setup();
        picker = s.picker;
        requestPickLine(3);
        await tick();
        expect(getCurrentPick().line).toBe(3);
        s.picker.reset();
        expect(getCurrentPick()).toBeNull();
        expect(s.overlay()).toBeUndefined();
        requestPickLine(3); // nothing to show any more
        await tick();
        expect(getCurrentPick()).toBeNull();
    });
});
