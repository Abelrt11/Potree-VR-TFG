class StatsGLCapture {
  constructor(THREE, width = 90, height = 48) {
    this.nodes = /* @__PURE__ */ new Map();
    this.width = 90;
    this.height = 48;
    this.THREE = THREE;
    this.width = width;
    this.height = height;
  }
  /**
   * Update capture dimensions (e.g., on resize)
   */
  resize(width, height) {
    var _a, _b;
    this.width = width;
    this.height = height;
    for (const [name, data] of this.nodes) {
      if (data.canvas instanceof HTMLCanvasElement) {
        data.canvas.width = width;
        data.canvas.height = height;
      } else if (data.canvas instanceof OffscreenCanvas) {
        const newCanvas = new OffscreenCanvas(width, height);
        data.canvas = newCanvas;
        (_b = (_a = data.canvasTarget).setCanvas) == null ? void 0 : _b.call(_a, newCanvas);
      }
      data.canvasTarget.setSize(width, height);
    }
  }
  register(name, targetNode) {
    if (this.nodes.has(name))
      return this.nodes.get(name);
    const { CanvasTarget, NodeMaterial, QuadMesh, NoToneMapping, LinearSRGBColorSpace } = this.THREE;
    const { renderOutput, vec3, vec4 } = this.THREE;
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(this.width, this.height) : document.createElement("canvas");
    if (canvas instanceof HTMLCanvasElement) {
      canvas.width = this.width;
      canvas.height = this.height;
    }
    const canvasTarget = new CanvasTarget(canvas);
    canvasTarget.setSize(this.width, this.height);
    const material = new NodeMaterial();
    material.outputNode = renderOutput(
      vec4(vec3(targetNode), 1),
      NoToneMapping,
      LinearSRGBColorSpace
    );
    const quad = new QuadMesh(material);
    const data = { canvas, canvasTarget, quad, material, node: targetNode };
    this.nodes.set(name, data);
    return data;
  }
  async capture(name, renderer) {
    const data = this.nodes.get(name);
    if (!data)
      return null;
    try {
      data.quad.render(renderer, data.canvasTarget);
      return await createImageBitmap(data.canvas);
    } catch (e) {
      return null;
    }
  }
  remove(name) {
    const data = this.nodes.get(name);
    if (data) {
      if (data.material && data.material.dispose) {
        data.material.dispose();
      }
      if (data.canvas instanceof HTMLCanvasElement && data.canvas.parentNode) {
        data.canvas.parentNode.removeChild(data.canvas);
      }
      this.nodes.delete(name);
    }
  }
  /**
   * Dispose all capture resources
   */
  dispose() {
    const names = Array.from(this.nodes.keys());
    for (const name of names) {
      this.remove(name);
    }
    this.nodes.clear();
  }
}
export {
  StatsGLCapture
};
//# sourceMappingURL=statsGLNode.js.map
