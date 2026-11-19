// @ts-ignore three ships no type declarations in this project
import * as THREE from 'three';
import pubsub from 'pubsub-js';

import ToolpathPicker from '../ToolpathPicker';
import {
    ISOLATE_CHANGED,
    PICK_CHANGED,
    getCurrentIsolation,
    getCurrentPick,
    requestIsolate,
    requestIsolateClear,
    requestPickClear,
    requestPickLine,
    requestPickStep,
} from '../pickTopics';

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

/*
 * Three operations, seen as in the first setup (1 mm = 1 px, screen = (x + 100, 100 - y)):
 *   line 0  (Op A)
 *   line 1  G1 X-50 Y0 -> X50 Y0      vertices 0,1
 *   line 2  (Op B)
 *   line 3  G1 X50 Y0 -> X50 Y50      vertices 2,3
 *   line 4  G1 X50 Y50 -> X-50 Y50    vertices 4,5
 *   line 5  (Op C)
 *   line 6  G1 X-50 Y50 -> X-50 Y-50  vertices 6,7
 */
const setupOperations = () => {
    const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    const vertices = Float32Array.from([
        -50, 0, 0, 50, 0, 0,
        50, 0, 0, 50, 50, 0,
        50, 50, 0, -50, 50, 0,
        -50, 50, 0, -50, -50, 0,
    ]);
    const colors = new Float32Array(8 * 4).fill(1);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    const toolpath = new THREE.Line(geometry, new THREE.LineBasicMaterial());
    toolpath.name = 'workpiece';
    const group = new THREE.Group();
    group.add(toolpath);

    const element = document.createElement('canvas');
    element.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    const render = jest.fn();
    const picker = new ToolpathPicker({ getCamera: () => camera, getToolpath: () => toolpath, render });
    picker.attach(element);
    const data = {
        frames: Uint32Array.from([2, 4, 6, 8]),
        frameLines: Uint32Array.from([1, 3, 4, 6]),
        vertices,
    };
    picker.setData(data);

    const click = (x: number, y: number) => {
        element.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, button: 0 }));
        element.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y, button: 0 }));
    };
    const isolated = () => group.getObjectByName('gg-isolated') as THREE.Line | undefined;
    const drawn = () => {
        const line = isolated();
        // what the renderer does before it draws the object
        line.onBeforeRender();
        const { start, count } = line.geometry.drawRange;
        return [start, start + count];
    };
    return { picker, click, render, group, toolpath, geometry, isolated, drawn, data };
};

const OP_A = { key: 'op:0', label: 'Op A', firstLine: 0, endLine: 2 };
const OP_B = { key: 'op:1', label: 'Op B', firstLine: 2, endLine: 5 };
const OP_C = { key: 'op:2', label: 'Op C', firstLine: 5, endLine: null as number | null };

describe('GGSender: one operation shown alone in the 3D view', () => {
    let picker: ToolpathPicker | null;
    afterEach(() => {
        picker?.dispose();
        picker = null;
    });

    it('hides the toolpath and draws only the moves of the operation, from the same buffers', () => {
        const s = setupOperations();
        picker = s.picker;
        const seen: any[] = [];
        const token = pubsub.subscribe(ISOLATE_CHANGED, (_m: string, p: any) => seen.push(p));
        requestIsolate(OP_B);
        pubsub.unsubscribe(token);

        expect(s.toolpath.visible).toBe(false);
        const line = s.isolated();
        expect(line).toBeTruthy();
        expect(line.visible).toBe(true);
        expect(s.drawn()).toEqual([2, 6]);
        // the same buffers and material: the colours of a running job stay correct
        expect(line.geometry.getAttribute('position')).toBe(s.geometry.getAttribute('position'));
        expect(line.geometry.getAttribute('color')).toBe(s.geometry.getAttribute('color'));
        expect(line.material).toBe(s.toolpath.material);
        // upstream takes the first child of the group for the toolpath
        expect(s.group.children[0]).toBe(s.toolpath);
        expect(getCurrentIsolation()).toEqual(OP_B);
        expect(seen).toEqual([OP_B]);
        expect(s.render).toHaveBeenCalled();
    });

    it('the last operation runs to the end of the toolpath', () => {
        const s = setupOperations();
        picker = s.picker;
        requestIsolate(OP_C);
        expect(s.drawn()).toEqual([6, 8]);
    });

    it('another operation replaces the first; "show all" brings the toolpath back', () => {
        const s = setupOperations();
        picker = s.picker;
        requestIsolate(OP_A);
        const first = s.isolated();
        requestIsolate(OP_B);
        expect(s.group.children.filter((c: THREE.Object3D) => c.name === 'gg-isolated')).toHaveLength(1);
        expect(s.isolated()).not.toBe(first);
        expect(s.drawn()).toEqual([2, 6]);

        const position = s.geometry.getAttribute('position');
        requestIsolateClear();
        expect(s.isolated()).toBeUndefined();
        expect(s.toolpath.visible).toBe(true);
        expect(getCurrentIsolation()).toBeNull();
        // the buffers of the toolpath are still its own
        expect(s.geometry.getAttribute('position')).toBe(position);
        expect(s.geometry.getAttribute('color')).toBeTruthy();
        expect(s.geometry.drawRange.start).toBe(0);
    });

    it('a click finds only moves of the operation shown', () => {
        const s = setupOperations();
        picker = s.picker;
        // without isolation the click at (0, 0) finds Op A (line 1)
        s.click(100, 100);
        expect(getCurrentPick().line).toBe(1);

        requestIsolate(OP_B);
        // the selected move is not in Op B: the highlight goes
        expect(getCurrentPick()).toBeNull();
        expect(s.group.getObjectByName('gg-pick')).toBeUndefined();
        // the same click finds nothing now: Op A is hidden
        s.click(100, 100);
        expect(getCurrentPick()).toBeNull();
        // a click on a move of Op B selects it
        s.click(100, 51); // near (0, 49), on line 4
        expect(getCurrentPick()).toEqual({ line: 4, drew: true, shownLine: 4 });
        expect(getCurrentIsolation()).toEqual(OP_B);
    });

    it('a selected move of the operation stays selected', async () => {
        const s = setupOperations();
        picker = s.picker;
        requestPickLine(3);
        await tick();
        requestIsolate(OP_B);
        expect(getCurrentPick().line).toBe(3);
        expect(s.group.getObjectByName('gg-pick')).toBeTruthy();
    });

    it('the steps stop at the first and the last move of the operation', async () => {
        const s = setupOperations();
        picker = s.picker;
        requestIsolate(OP_B);
        requestPickStep(1); // no line yet: the first move of the operation
        await tick();
        expect(getCurrentPick().line).toBe(3);
        requestPickStep(-1);
        await tick();
        expect(getCurrentPick().line).toBe(3); // line 1 is in Op A
        requestPickStep(1);
        await tick();
        expect(getCurrentPick().line).toBe(4);
        requestPickStep(1);
        await tick();
        expect(getCurrentPick().line).toBe(4); // line 6 is in Op C
        expect(getCurrentIsolation()).toEqual(OP_B);

        requestPickClear();
        await tick();
        requestPickStep(-1); // no line: the last move of the operation
        await tick();
        expect(getCurrentPick().line).toBe(4);
    });

    it('a line asked for by number outside of the operation shows everything again', async () => {
        const s = setupOperations();
        picker = s.picker;
        requestIsolate(OP_B);
        requestPickLine(4); // inside: nothing changes
        await tick();
        expect(getCurrentIsolation()).toEqual(OP_B);
        requestPickLine(6); // in Op C
        await tick();
        expect(getCurrentIsolation()).toBeNull();
        expect(s.toolpath.visible).toBe(true);
        expect(s.isolated()).toBeUndefined();
        expect(getCurrentPick().line).toBe(6);
    });

    it('follows the lines that upstream hides during a job', () => {
        const s = setupOperations();
        picker = s.picker;
        requestIsolate(OP_B);
        expect(s.drawn()).toEqual([2, 6]);
        // "hide processed lines": upstream draws the toolpath from vertex 3 on
        s.geometry.setDrawRange(3, 5);
        expect(s.drawn()).toEqual([3, 6]);
        // all of the operation is done
        s.geometry.setDrawRange(7, 1);
        expect(s.drawn()[1] - s.drawn()[0]).toBe(0);
        // upstream shows everything again
        s.geometry.setDrawRange(0, Infinity);
        expect(s.drawn()).toEqual([2, 6]);
    });

    it('lines that drew nothing: nothing is hidden', () => {
        const s = setupOperations();
        picker = s.picker;
        requestIsolate({ key: 'op:9', label: 'Notes', firstLine: 0, endLine: 1 });
        expect(s.isolated()).toBeUndefined();
        expect(s.toolpath.visible).toBe(true);
        expect(getCurrentIsolation()).toBeNull();
    });

    it('a new file, or no file, ends it', () => {
        const s = setupOperations();
        picker = s.picker;
        requestIsolate(OP_B);
        s.picker.setData(s.data);
        expect(s.isolated()).toBeUndefined();
        expect(s.toolpath.visible).toBe(true);
        expect(getCurrentIsolation()).toBeNull();

        requestIsolate(OP_B);
        expect(s.isolated()).toBeTruthy();
        s.picker.reset();
        expect(s.isolated()).toBeUndefined();
        expect(getCurrentIsolation()).toBeNull();
        requestIsolate(OP_B); // no toolpath data: nothing to show alone
        expect(s.isolated()).toBeUndefined();
        expect(s.toolpath.visible).toBe(true);
    });

    it('when the 3D view goes away, the toolpath is whole again', () => {
        const s = setupOperations();
        requestIsolate(OP_B);
        s.picker.dispose();
        expect(s.isolated()).toBeUndefined();
        expect(s.toolpath.visible).toBe(true);
    });
});
