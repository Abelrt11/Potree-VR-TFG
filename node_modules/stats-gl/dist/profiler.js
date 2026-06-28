import { StatsCore } from "./core.js";
import { TextureCaptureWebGL, extractWebGLSource, TextureCaptureWebGPU, extractWebGPUSource } from "./textureCapture.js";
class StatsProfiler extends StatsCore {
  constructor(options = {}) {
    super(options);
    this.textureCaptureWebGL = null;
    this.textureCaptureWebGPU = null;
  }
  update() {
    this.endProfiling();
    if (!this.info) {
      this.processGpuQueries();
    } else {
      this.processWebGPUTimestamps();
    }
    const fps = this.calculateFps();
    this.addToAverage(fps, this.averageFps);
    this.updateAverages();
    this.resetCounters();
  }
  getData() {
    return super.getData();
  }
  /**
   * Capture a texture/render target to ImageBitmap for transfer to main thread
   * @param source - Three.js RenderTarget, GPUTexture, or WebGLFramebuffer with dimensions
   * @param sourceId - Unique identifier for this texture source (for per-source PBO buffering)
   * @returns ImageBitmap suitable for postMessage transfer
   */
  async captureTexture(source, sourceId = "default") {
    if (this.gl) {
      if (!this.textureCaptureWebGL) {
        this.textureCaptureWebGL = new TextureCaptureWebGL(this.gl);
      }
      if (source.isWebGLRenderTarget) {
        const webglSource = extractWebGLSource(source, this.gl);
        if (webglSource) {
          return this.textureCaptureWebGL.capture(
            webglSource.framebuffer,
            webglSource.width,
            webglSource.height,
            sourceId
          );
        }
      }
      if (source.framebuffer && source.width && source.height) {
        return this.textureCaptureWebGL.capture(
          source.framebuffer,
          source.width,
          source.height,
          sourceId
        );
      }
    }
    if (this.gpuDevice) {
      if (!this.textureCaptureWebGPU) {
        this.textureCaptureWebGPU = new TextureCaptureWebGPU(this.gpuDevice);
      }
      if (source.isRenderTarget && this.gpuBackend) {
        const gpuTexture = extractWebGPUSource(source, this.gpuBackend);
        if (gpuTexture) {
          return this.textureCaptureWebGPU.capture(gpuTexture);
        }
      }
      if (source && typeof source.createView === "function") {
        return this.textureCaptureWebGPU.capture(source);
      }
    }
    return null;
  }
  /**
   * Dispose texture capture resources
   */
  disposeTextureCapture() {
    if (this.textureCaptureWebGL) {
      this.textureCaptureWebGL.dispose();
      this.textureCaptureWebGL = null;
    }
    if (this.textureCaptureWebGPU) {
      this.textureCaptureWebGPU.dispose();
      this.textureCaptureWebGPU = null;
    }
  }
  /**
   * Dispose of all resources
   */
  dispose() {
    this.disposeTextureCapture();
    super.dispose();
  }
}
export {
  StatsProfiler
};
//# sourceMappingURL=profiler.js.map
