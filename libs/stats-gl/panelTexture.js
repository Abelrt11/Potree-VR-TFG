import { Panel } from "./panel.js";
class PanelTexture extends Panel {
  // Source texture aspect ratio (width/height)
  constructor(name) {
    super(name, "#fff", "#111");
    this.currentBitmap = null;
    this.sourceAspect = 1;
    this.initializeCanvas();
  }
  initializeCanvas() {
    if (!this.context)
      return;
    this.context.imageSmoothingEnabled = true;
    this.context.font = "bold " + 9 * this.PR + "px Helvetica,Arial,sans-serif";
    this.context.textBaseline = "top";
    this.context.fillStyle = "#000";
    this.context.fillRect(0, 0, this.WIDTH, this.HEIGHT);
    this.drawLabelOverlay();
  }
  drawLabelOverlay() {
    if (!this.context)
      return;
    this.context.fillStyle = "rgba(0, 0, 0, 0.5)";
    this.context.fillRect(0, 0, this.WIDTH, this.GRAPH_Y);
    this.context.fillStyle = this.fg;
    this.context.fillText(this.name, this.TEXT_X, this.TEXT_Y);
  }
  /**
   * Set the source texture aspect ratio for proper display
   * @param width - Source texture width
   * @param height - Source texture height
   */
  setSourceSize(width, height) {
    this.sourceAspect = width / height;
  }
  updateTexture(bitmap) {
    if (!this.context)
      return;
    if (this.currentBitmap) {
      this.currentBitmap.close();
    }
    this.currentBitmap = bitmap;
    this.context.fillStyle = "#000";
    this.context.fillRect(0, 0, this.WIDTH, this.HEIGHT);
    const panelAspect = this.WIDTH / this.HEIGHT;
    let destWidth;
    let destHeight;
    let destX;
    let destY;
    if (this.sourceAspect > panelAspect) {
      destWidth = this.WIDTH;
      destHeight = this.WIDTH / this.sourceAspect;
      destX = 0;
      destY = (this.HEIGHT - destHeight) / 2;
    } else {
      destHeight = this.HEIGHT;
      destWidth = this.HEIGHT * this.sourceAspect;
      destX = (this.WIDTH - destWidth) / 2;
      destY = 0;
    }
    this.context.drawImage(
      bitmap,
      destX,
      destY,
      destWidth,
      destHeight
    );
    this.drawLabelOverlay();
  }
  setLabel(label) {
    this.name = label;
    this.drawLabelOverlay();
  }
  // Override update - not used for texture panels
  update(_value, _maxValue, _decimals = 0, _suffix = "") {
  }
  // Override updateGraph - not used for texture panels
  updateGraph(_valueGraph, _maxGraph) {
  }
  /**
   * Dispose of resources
   */
  dispose() {
    if (this.currentBitmap) {
      this.currentBitmap.close();
      this.currentBitmap = null;
    }
  }
}
export {
  PanelTexture
};
//# sourceMappingURL=panelTexture.js.map
