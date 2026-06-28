const DEFAULT_PREVIEW_WIDTH = 90;
const DEFAULT_PREVIEW_HEIGHT = 48;
class TextureCaptureWebGL {
  constructor(gl, width = DEFAULT_PREVIEW_WIDTH, height = DEFAULT_PREVIEW_HEIGHT) {
    this.previewFbo = null;
    this.previewTexture = null;
    this.gl = gl;
    this.previewWidth = width;
    this.previewHeight = height;
    this.pixels = new Uint8Array(width * height * 4);
    this.flippedPixels = new Uint8Array(width * height * 4);
    this.initResources();
  }
  /**
   * Resize preview dimensions
   */
  resize(width, height) {
    if (width === this.previewWidth && height === this.previewHeight)
      return;
    this.previewWidth = width;
    this.previewHeight = height;
    this.pixels = new Uint8Array(width * height * 4);
    this.flippedPixels = new Uint8Array(width * height * 4);
    this.dispose();
    this.initResources();
  }
  initResources() {
    const gl = this.gl;
    this.previewTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.previewTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.previewWidth, this.previewHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.previewFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.previewFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.previewTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  async capture(source, sourceWidth, sourceHeight, _sourceId = "default") {
    const gl = this.gl;
    const prevReadFbo = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const prevDrawFbo = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.previewFbo);
    gl.blitFramebuffer(
      0,
      0,
      sourceWidth,
      sourceHeight,
      0,
      0,
      this.previewWidth,
      this.previewHeight,
      gl.COLOR_BUFFER_BIT,
      gl.LINEAR
    );
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.previewFbo);
    gl.readPixels(0, 0, this.previewWidth, this.previewHeight, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevReadFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDrawFbo);
    const flipped = this.flipY(this.pixels, this.previewWidth, this.previewHeight);
    const imageData = new ImageData(new Uint8ClampedArray(flipped), this.previewWidth, this.previewHeight);
    return createImageBitmap(imageData);
  }
  flipY(pixels, width, height) {
    const rowSize = width * 4;
    for (let y = 0; y < height; y++) {
      const srcOffset = y * rowSize;
      const dstOffset = (height - 1 - y) * rowSize;
      this.flippedPixels.set(pixels.subarray(srcOffset, srcOffset + rowSize), dstOffset);
    }
    return this.flippedPixels;
  }
  removeSource(_sourceId) {
  }
  dispose() {
    const gl = this.gl;
    if (this.previewFbo) {
      gl.deleteFramebuffer(this.previewFbo);
      this.previewFbo = null;
    }
    if (this.previewTexture) {
      gl.deleteTexture(this.previewTexture);
      this.previewTexture = null;
    }
  }
}
class TextureCaptureWebGPU {
  constructor(device, width = DEFAULT_PREVIEW_WIDTH, height = DEFAULT_PREVIEW_HEIGHT) {
    this.previewTexture = null;
    this.stagingBuffer = null;
    this.blitPipeline = null;
    this.sampler = null;
    this.bindGroupLayout = null;
    this.initialized = false;
    this.device = device;
    this.previewWidth = width;
    this.previewHeight = height;
    this.pixelsBuffer = new Uint8ClampedArray(width * height * 4);
  }
  /**
   * Resize preview dimensions
   */
  resize(width, height) {
    if (width === this.previewWidth && height === this.previewHeight)
      return;
    this.previewWidth = width;
    this.previewHeight = height;
    this.pixelsBuffer = new Uint8ClampedArray(width * height * 4);
    if (this.previewTexture)
      this.previewTexture.destroy();
    if (this.stagingBuffer)
      this.stagingBuffer.destroy();
    this.previewTexture = null;
    this.stagingBuffer = null;
    if (this.initialized) {
      this.createSizeResources();
    }
  }
  createSizeResources() {
    const device = this.device;
    this.previewTexture = device.createTexture({
      size: { width: this.previewWidth, height: this.previewHeight },
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    const bytesPerRow = Math.ceil(this.previewWidth * 4 / 256) * 256;
    this.stagingBuffer = device.createBuffer({
      size: bytesPerRow * this.previewHeight,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
  }
  async initResources() {
    if (this.initialized)
      return;
    const device = this.device;
    this.createSizeResources();
    this.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear"
    });
    const shaderModule = device.createShaderModule({
      code: `
        @group(0) @binding(0) var texSampler: sampler;
        @group(0) @binding(1) var texInput: texture_2d<f32>;

        struct VertexOutput {
          @builtin(position) position: vec4f,
          @location(0) uv: vec2f
        }

        @vertex
        fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
          var positions = array<vec2f, 3>(
            vec2f(-1.0, -1.0),
            vec2f(3.0, -1.0),
            vec2f(-1.0, 3.0)
          );
          var uvs = array<vec2f, 3>(
            vec2f(0.0, 1.0),
            vec2f(2.0, 1.0),
            vec2f(0.0, -1.0)
          );

          var output: VertexOutput;
          output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
          output.uv = uvs[vertexIndex];
          return output;
        }

        @fragment
        fn fragmentMain(@location(0) uv: vec2f) -> @location(0) vec4f {
          return textureSample(texInput, texSampler, uv);
        }
      `
    });
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
      ]
    });
    this.blitPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain"
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: "rgba8unorm" }]
      },
      primitive: { topology: "triangle-list" }
    });
    this.initialized = true;
  }
  async capture(source) {
    await this.initResources();
    if (!this.previewTexture || !this.stagingBuffer || !this.blitPipeline || !this.sampler || !this.bindGroupLayout) {
      return null;
    }
    const device = this.device;
    const bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: source.createView() }
      ]
    });
    const commandEncoder = device.createCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.previewTexture.createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 }
      }]
    });
    renderPass.setPipeline(this.blitPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.draw(3);
    renderPass.end();
    const bytesPerRow = Math.ceil(this.previewWidth * 4 / 256) * 256;
    commandEncoder.copyTextureToBuffer(
      { texture: this.previewTexture },
      { buffer: this.stagingBuffer, bytesPerRow },
      { width: this.previewWidth, height: this.previewHeight }
    );
    device.queue.submit([commandEncoder.finish()]);
    await this.stagingBuffer.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(this.stagingBuffer.getMappedRange());
    for (let y = 0; y < this.previewHeight; y++) {
      const srcOffset = y * bytesPerRow;
      const dstOffset = y * this.previewWidth * 4;
      this.pixelsBuffer.set(data.subarray(srcOffset, srcOffset + this.previewWidth * 4), dstOffset);
    }
    this.stagingBuffer.unmap();
    const imageData = new ImageData(new Uint8ClampedArray(this.pixelsBuffer), this.previewWidth, this.previewHeight);
    return createImageBitmap(imageData);
  }
  dispose() {
    if (this.previewTexture)
      this.previewTexture.destroy();
    if (this.stagingBuffer)
      this.stagingBuffer.destroy();
    this.previewTexture = null;
    this.stagingBuffer = null;
    this.blitPipeline = null;
    this.sampler = null;
    this.bindGroupLayout = null;
    this.initialized = false;
  }
}
function extractWebGLSource(target, gl) {
  if (target.isWebGLRenderTarget && target.__webglFramebuffer) {
    return {
      framebuffer: target.__webglFramebuffer,
      width: target.width || 1,
      height: target.height || 1
    };
  }
  return null;
}
function extractWebGPUSource(target, backend) {
  if (target.isRenderTarget && target.texture && backend.get) {
    const textureData = backend.get(target.texture);
    return (textureData == null ? void 0 : textureData.texture) || null;
  }
  return null;
}
export {
  DEFAULT_PREVIEW_HEIGHT,
  DEFAULT_PREVIEW_WIDTH,
  TextureCaptureWebGL,
  TextureCaptureWebGPU,
  extractWebGLSource,
  extractWebGPUSource
};
//# sourceMappingURL=textureCapture.js.map
