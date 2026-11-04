/** The bit of a regl-scatterplot instance this needs. */
interface GlInstance {
    get?: (key: 'renderer') => { canvas?: HTMLCanvasElement } | undefined;
    destroy: () => void;
}

/**
 * destroy() leaves the WebGL context alive until garbage collection, so rebuilds
 * can pass Chromium's ~16 context limit and evict a live chart. Release it now.
 * Remove any context-lost listener first: this fires that event.
 */
export function destroyReleasingContext(inst: GlInstance): void {
    const canvas = inst.get?.('renderer')?.canvas;
    inst.destroy();
    const gl = canvas?.getContext?.('webgl2') ?? canvas?.getContext?.('webgl');
    gl?.getExtension?.('WEBGL_lose_context')?.loseContext();
}
