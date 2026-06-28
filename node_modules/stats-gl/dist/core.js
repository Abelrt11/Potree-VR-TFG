class StatsCore {
  constructor({
    trackGPU = false,
    trackCPT = false,
    trackHz = false,
    trackFPS = true,
    logsPerSecond = 4,
    graphsPerSecond = 30,
    samplesLog = 40,
    samplesGraph = 10,
    precision = 2
  } = {}) {
    this.gl = null;
    this.ext = null;
    this.gpuDevice = null;
    this.gpuBackend = null;
    this.renderer = null;
    this.activeQuery = null;
    this.gpuQueries = [];
    this.threeRendererPatched = false;
    this.webgpuNative = false;
    this.gpuQuerySet = null;
    this.gpuResolveBuffer = null;
    this.gpuReadBuffers = [];
    this.gpuWriteBufferIndex = 0;
    this.gpuFrameCount = 0;
    this.pendingResolve = null;
    this.frameTimes = [];
    this.frameTimesHead = 0;
    this.renderCount = 0;
    this.cpuStartTime = 0;
    this.totalCpuDuration = 0;
    this.totalGpuDuration = 0;
    this.totalGpuDurationCompute = 0;
    this.averageFps = { logs: [], graph: [] };
    this.averageCpu = { logs: [], graph: [] };
    this.averageGpu = { logs: [], graph: [] };
    this.averageGpuCompute = { logs: [], graph: [] };
    this.trackGPU = trackGPU;
    this.trackCPT = trackCPT;
    this.trackHz = trackHz;
    this.trackFPS = trackFPS;
    this.samplesLog = samplesLog;
    this.samplesGraph = samplesGraph;
    this.precision = precision;
    this.logsPerSecond = logsPerSecond;
    this.graphsPerSecond = graphsPerSecond;
    const now = performance.now();
    this.prevGraphTime = now;
    this.beginTime = now;
    this.prevTextTime = now;
    this.prevCpuTime = now;
  }
  async init(canvasOrGL) {
    if (!canvasOrGL) {
      console.error('Stats: The "canvas" parameter is undefined.');
      return;
    }
    if (this.handleThreeRenderer(canvasOrGL))
      return;
    if (await this.handleWebGPURenderer(canvasOrGL))
      return;
    if (this.handleNativeWebGPU(canvasOrGL))
      return;
    if (this.initializeWebGL(canvasOrGL)) {
      if (this.trackGPU) {
        this.initializeGPUTracking();
      }
      return;
    } else {
      console.error("Stats-gl: Failed to initialize WebGL context");
    }
  }
  handleNativeWebGPU(device) {
    var _a;
    if (device && typeof device.createCommandEncoder === "function" && typeof device.createQuerySet === "function" && device.queue) {
      this.gpuDevice = device;
      this.webgpuNative = true;
      if (this.trackGPU && ((_a = device.features) == null ? void 0 : _a.has("timestamp-query"))) {
        this.initializeWebGPUTiming();
        this.onWebGPUTimestampSupported();
      }
      return true;
    }
    return false;
  }
  initializeWebGPUTiming() {
    if (!this.gpuDevice)
      return;
    this.gpuQuerySet = this.gpuDevice.createQuerySet({
      type: "timestamp",
      count: 2
    });
    this.gpuResolveBuffer = this.gpuDevice.createBuffer({
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
    });
    for (let i = 0; i < 2; i++) {
      this.gpuReadBuffers.push(this.gpuDevice.createBuffer({
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      }));
    }
  }
  handleThreeRenderer(renderer) {
    if (renderer.isWebGLRenderer && !this.threeRendererPatched) {
      this.patchThreeRenderer(renderer);
      this.gl = renderer.getContext();
      if (this.trackGPU) {
        this.initializeGPUTracking();
      }
      return true;
    }
    return false;
  }
  async handleWebGPURenderer(renderer) {
    var _a;
    if (renderer.isWebGPURenderer) {
      this.renderer = renderer;
      if (this.trackGPU || this.trackCPT) {
        renderer.backend.trackTimestamp = true;
        if (!renderer._initialized) {
          await renderer.init();
        }
        if (renderer.hasFeature("timestamp-query")) {
          this.onWebGPUTimestampSupported();
        }
      }
      this.info = renderer.info;
      this.gpuBackend = renderer.backend;
      this.gpuDevice = ((_a = renderer.backend) == null ? void 0 : _a.device) || null;
      this.patchThreeWebGPU(renderer);
      return true;
    }
    return false;
  }
  onWebGPUTimestampSupported() {
  }
  initializeWebGL(canvasOrGL) {
    if (canvasOrGL instanceof WebGL2RenderingContext) {
      this.gl = canvasOrGL;
    } else if (canvasOrGL instanceof HTMLCanvasElement || canvasOrGL instanceof OffscreenCanvas) {
      this.gl = canvasOrGL.getContext("webgl2");
      if (!this.gl) {
        console.error("Stats: Unable to obtain WebGL2 context.");
        return false;
      }
    } else {
      console.error(
        "Stats: Invalid input type. Expected WebGL2RenderingContext, HTMLCanvasElement, or OffscreenCanvas."
      );
      return false;
    }
    return true;
  }
  initializeGPUTracking() {
    if (this.gl) {
      this.ext = this.gl.getExtension("EXT_disjoint_timer_query_webgl2");
      if (this.ext) {
        this.onGPUTrackingInitialized();
      }
    }
  }
  onGPUTrackingInitialized() {
  }
  /**
   * Get timestampWrites configuration for WebGPU render pass.
   * Use this when creating your render pass descriptor.
   * @returns timestampWrites object or undefined if not tracking GPU
   */
  getTimestampWrites() {
    if (!this.webgpuNative || !this.gpuQuerySet)
      return void 0;
    return {
      querySet: this.gpuQuerySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1
    };
  }
  begin(encoder) {
    this.beginProfiling();
    if (this.webgpuNative) {
      return;
    }
    if (!this.gl || !this.ext)
      return;
    if (this.activeQuery) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    }
    this.activeQuery = this.gl.createQuery();
    if (this.activeQuery) {
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.activeQuery);
    }
  }
  end(encoder) {
    this.renderCount++;
    if (this.webgpuNative && encoder && this.gpuQuerySet && this.gpuResolveBuffer && this.gpuReadBuffers.length > 0) {
      this.gpuFrameCount++;
      const writeBuffer = this.gpuReadBuffers[this.gpuWriteBufferIndex];
      if (writeBuffer.mapState === "unmapped") {
        encoder.resolveQuerySet(this.gpuQuerySet, 0, 2, this.gpuResolveBuffer, 0);
        encoder.copyBufferToBuffer(this.gpuResolveBuffer, 0, writeBuffer, 0, 16);
      }
      this.endProfiling();
      return;
    }
    if (this.gl && this.ext && this.activeQuery) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.gpuQueries.push({ query: this.activeQuery });
      this.activeQuery = null;
    }
    this.endProfiling();
  }
  /**
   * Resolve WebGPU timestamp queries. Call this after queue.submit().
   * Returns a promise that resolves to the GPU duration in milliseconds.
   */
  async resolveTimestampsAsync() {
    if (!this.webgpuNative || this.gpuReadBuffers.length === 0) {
      return this.totalGpuDuration;
    }
    if (this.pendingResolve) {
      return this.pendingResolve;
    }
    const readBufferIndex = (this.gpuWriteBufferIndex + 1) % 2;
    const readBuffer = this.gpuReadBuffers[readBufferIndex];
    this.gpuWriteBufferIndex = (this.gpuWriteBufferIndex + 1) % 2;
    if (this.gpuFrameCount < 2) {
      return this.totalGpuDuration;
    }
    if (readBuffer.mapState !== "unmapped") {
      return this.totalGpuDuration;
    }
    this.pendingResolve = this._resolveTimestamps(readBuffer);
    try {
      const result = await this.pendingResolve;
      return result;
    } finally {
      this.pendingResolve = null;
    }
  }
  async _resolveTimestamps(readBuffer) {
    try {
      await readBuffer.mapAsync(GPUMapMode.READ);
      const data = new BigInt64Array(readBuffer.getMappedRange());
      const startTime = data[0];
      const endTime = data[1];
      readBuffer.unmap();
      const durationNs = Number(endTime - startTime);
      this.totalGpuDuration = durationNs / 1e6;
      return this.totalGpuDuration;
    } catch (_) {
      return this.totalGpuDuration;
    }
  }
  processGpuQueries() {
    if (!this.gl || !this.ext)
      return;
    this.totalGpuDuration = 0;
    for (let i = this.gpuQueries.length - 1; i >= 0; i--) {
      const queryInfo = this.gpuQueries[i];
      const available = this.gl.getQueryParameter(queryInfo.query, this.gl.QUERY_RESULT_AVAILABLE);
      const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (available && !disjoint) {
        const elapsed = this.gl.getQueryParameter(queryInfo.query, this.gl.QUERY_RESULT);
        const duration = elapsed * 1e-6;
        this.totalGpuDuration += duration;
        this.gl.deleteQuery(queryInfo.query);
        this.gpuQueries.splice(i, 1);
      }
    }
  }
  processWebGPUTimestamps() {
    this.totalGpuDuration = this.info.render.timestamp;
    this.totalGpuDurationCompute = this.info.compute.timestamp;
  }
  beginProfiling() {
    this.cpuStartTime = performance.now();
  }
  endProfiling() {
    this.totalCpuDuration += performance.now() - this.cpuStartTime;
  }
  calculateFps() {
    const currentTime = performance.now();
    const cutoff = currentTime - 1e3;
    this.frameTimes.push(currentTime);
    while (this.frameTimesHead < this.frameTimes.length && this.frameTimes[this.frameTimesHead] <= cutoff) {
      this.frameTimesHead++;
    }
    if (this.frameTimesHead > 128) {
      this.frameTimes = this.frameTimes.slice(this.frameTimesHead);
      this.frameTimesHead = 0;
    }
    return Math.round(this.frameTimes.length - this.frameTimesHead);
  }
  updateAverages() {
    this.addToAverage(this.totalCpuDuration, this.averageCpu);
    this.addToAverage(this.totalGpuDuration, this.averageGpu);
    if (this.info && this.totalGpuDurationCompute !== void 0) {
      this.addToAverage(this.totalGpuDurationCompute, this.averageGpuCompute);
    }
  }
  addToAverage(value, averageArray) {
    averageArray.logs.push(value);
    while (averageArray.logs.length > this.samplesLog) {
      averageArray.logs.shift();
    }
    averageArray.graph.push(value);
    while (averageArray.graph.length > this.samplesGraph) {
      averageArray.graph.shift();
    }
  }
  resetCounters() {
    this.renderCount = 0;
    this.totalCpuDuration = 0;
    this.beginTime = performance.now();
  }
  getData() {
    const fpsLogs = this.averageFps.logs;
    const cpuLogs = this.averageCpu.logs;
    const gpuLogs = this.averageGpu.logs;
    const gpuComputeLogs = this.averageGpuCompute.logs;
    return {
      fps: fpsLogs.length > 0 ? fpsLogs[fpsLogs.length - 1] : 0,
      cpu: cpuLogs.length > 0 ? cpuLogs[cpuLogs.length - 1] : 0,
      gpu: gpuLogs.length > 0 ? gpuLogs[gpuLogs.length - 1] : 0,
      gpuCompute: gpuComputeLogs.length > 0 ? gpuComputeLogs[gpuComputeLogs.length - 1] : 0
    };
  }
  patchThreeWebGPU(renderer) {
    const originalAnimationLoop = renderer.info.reset;
    const statsInstance = this;
    renderer.info.reset = function() {
      statsInstance.beginProfiling();
      originalAnimationLoop.call(this);
    };
  }
  patchThreeRenderer(renderer) {
    const originalRenderMethod = renderer.render;
    const statsInstance = this;
    renderer.render = function(scene, camera) {
      statsInstance.begin();
      originalRenderMethod.call(this, scene, camera);
      statsInstance.end();
    };
    this.threeRendererPatched = true;
  }
  /**
   * Dispose of all resources. Call when done using the stats instance.
   */
  dispose() {
    if (this.gl) {
      if (this.activeQuery && this.ext) {
        try {
          this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
        } catch (_) {
        }
        this.gl.deleteQuery(this.activeQuery);
        this.activeQuery = null;
      }
      for (const queryInfo of this.gpuQueries) {
        this.gl.deleteQuery(queryInfo.query);
      }
      this.gpuQueries.length = 0;
    }
    if (this.gpuQuerySet) {
      this.gpuQuerySet.destroy();
      this.gpuQuerySet = null;
    }
    if (this.gpuResolveBuffer) {
      this.gpuResolveBuffer.destroy();
      this.gpuResolveBuffer = null;
    }
    for (const buffer of this.gpuReadBuffers) {
      if (buffer.mapState === "mapped") {
        buffer.unmap();
      }
      buffer.destroy();
    }
    this.gpuReadBuffers.length = 0;
    this.gpuFrameCount = 0;
    this.pendingResolve = null;
    this.webgpuNative = false;
    this.gl = null;
    this.ext = null;
    this.info = void 0;
    this.gpuDevice = null;
    this.gpuBackend = null;
    this.renderer = null;
    this.frameTimes.length = 0;
    this.frameTimesHead = 0;
    this.averageFps.logs.length = 0;
    this.averageFps.graph.length = 0;
    this.averageCpu.logs.length = 0;
    this.averageCpu.graph.length = 0;
    this.averageGpu.logs.length = 0;
    this.averageGpu.graph.length = 0;
    this.averageGpuCompute.logs.length = 0;
    this.averageGpuCompute.graph.length = 0;
  }
}
export {
  StatsCore
};
//# sourceMappingURL=core.js.map
