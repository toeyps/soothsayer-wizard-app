/** The bit of a regl-scatterplot instance this needs. */
interface GlInstance {
    get?: (key: 'renderer') => { canvas?: HTMLCanvasElement } | undefined;
    destroy: () => void;
}

/** destroy() keeps the WebGL context until GC, so rebuilds can pass Chromium's ~16-context limit; release it now. Callers remove their context-lost listener first (this fires it). */
export function destroyReleasingContext(inst: GlInstance): void {
    const canvas = inst.get?.('renderer')?.canvas;
    inst.destroy();
    const gl = canvas?.getContext?.('webgl2') ?? canvas?.getContext?.('webgl');
    gl?.getExtension?.('WEBGL_lose_context')?.loseContext();
}
