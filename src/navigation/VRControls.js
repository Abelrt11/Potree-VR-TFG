
import * as THREE from "../../libs/three.js/build/three.module.js";
import {EventDispatcher} from "../EventDispatcher.js";
import { XRControllerModelFactory } from '../../libs/three.js/webxr/XRControllerModelFactory.js';
import {Line2} from "../../libs/three.js/lines/Line2.js";
import {LineGeometry} from "../../libs/three.js/lines/LineGeometry.js";
import {LineMaterial} from "../../libs/three.js/lines/LineMaterial.js";

let fakeCam = new THREE.PerspectiveCamera();

// Paleta cíclica para cambiar el color de las clases en VR (sin color-picker).
const CLASS_COLOR_PALETTE = [
	[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 0.0],
	[1.0, 0.0, 1.0], [0.0, 1.0, 1.0], [1.0, 0.5, 0.0], [1.0, 1.0, 1.0],
];

// Picking en VR: semiángulo (grados) del cono de selección alrededor del puntero.
// Solo se consideran puntos dentro de este cono; entre ellos gana el más cercano al
// mando (primera superficie), no el más pegado a la recta infinita. Ajustable.
const VR_PICK_CONE_HALF_ANGLE_DEG = 1.5;
const VR_PICK_TAN2 = Math.tan(VR_PICK_CONE_HALF_ANGLE_DEG * Math.PI / 180) ** 2;

// Giro suave del joystick izquierdo: rad/s a deflexión máxima y zona muerta.
const VR_TURN_SPEED_RAD_PER_SEC = Math.PI * 0.6; // ~108°/s, ajustable
const VR_TURN_DEADZONE = 0.2;

function toScene(vec, ref){
	let node = ref.clone();
	node.updateMatrix();
	node.updateMatrixWorld();

	let result = vec.clone().applyMatrix4(node.matrix);
	result.z -= 0.8 * node.scale.x;

	return result;
};

function computeMove(vrControls, controller){

	if(!controller || !controller.inputSource || !controller.inputSource.gamepad){
		return null;
	}

	let pad = controller.inputSource.gamepad;

	let axes = pad.axes;
	// [0,1] are for touchpad, [2,3] for thumbsticks?
	let y = 0;
	if(axes.length === 2){
		y = axes[1];
	}else if(axes.length === 4){
		y = axes[3];
	}

	y = Math.sign(y) * (2 * y) ** 2;

	let maxSize = 0;
	for(let pc of viewer.scene.pointclouds){
		let size = pc.boundingBox.min.distanceTo(pc.boundingBox.max);
		maxSize = Math.max(maxSize, size);
	}
	let multiplicator = Math.pow(maxSize, 0.5) / 2;

	let scale = vrControls.node.scale.x;
	let moveSpeed = viewer.getMoveSpeed();
	let amount = multiplicator * y * (moveSpeed ** 0.5) / scale;


	let rotation = new THREE.Quaternion().setFromEuler(controller.rotation);
	let dir = new THREE.Vector3(0, 0, -1);
	dir.applyQuaternion(rotation);

	let move = dir.clone().multiplyScalar(amount);

	let p1 = vrControls.toScene(controller.position);
	let p2 = vrControls.toScene(controller.position.clone().add(move));

	move = p2.clone().sub(p1);

	return move;
};

// Lee el eje X del joystick (giro). Aplica zona muerta para evitar deriva en reposo.
function computeTurn(controller){
	if(!controller || !controller.inputSource || !controller.inputSource.gamepad){
		return 0;
	}

	let axes = controller.inputSource.gamepad.axes;
	let x = (axes.length === 2) ? axes[0] : (axes.length === 4) ? axes[2] : 0;

	if(Math.abs(x) < VR_TURN_DEADZONE){
		return 0;
	}

	return x;
};


class FlyMode{

	constructor(vrControls){
		this.moveFactor = 1;
		this.dbgLabel = null;
	}

	start(vrControls){
		if(!this.dbgLabel){
			this.dbgLabel = new Potree.TextSprite("abc");
			this.dbgLabel.name = "debug label";
			vrControls.viewer.sceneVR.add(this.dbgLabel);
			this.dbgLabel.visible = false;
		}
	}
	
	end(){

	}

	update(vrControls, delta){

		// Mando derecho = avanzar/retroceder; mando izquierdo = girar.
		let right = vrControls._getRightController() || vrControls.cPrimary;
		let left  = vrControls._getLeftController()
			|| (right === vrControls.cPrimary ? vrControls.cSecondary : vrControls.cPrimary);

		let primary = right;

		// Avance solo con el mando derecho (el izquierdo ya no avanza, solo gira).
		let move = computeMove(vrControls, right) || new THREE.Vector3();

		move.multiplyScalar(-delta * this.moveFactor);
		vrControls.node.position.add(move);

		// Giro suave y continuo con el eje X del joystick izquierdo, antes de
		// volcar la orientación a la vista de escritorio (setView, más abajo).
		let turnX = computeTurn(left);
		if(turnX !== 0){
			vrControls.rotateView(-turnX * VR_TURN_SPEED_RAD_PER_SEC * delta);
		}

		let scale = vrControls.node.scale.x;

		let camVR = vrControls.viewer.renderer.xr.getCamera(fakeCam);
		
		let vrPos = camVR.getWorldPosition(new THREE.Vector3());
		let vrDir = camVR.getWorldDirection(new THREE.Vector3());
		let vrTarget = vrPos.clone().add(vrDir.multiplyScalar(scale));

		let scenePos = toScene(vrPos, vrControls.node);
		let sceneDir = toScene(vrPos.clone().add(vrDir), vrControls.node).sub(scenePos);
		sceneDir.normalize().multiplyScalar(scale);
		let sceneTarget = scenePos.clone().add(sceneDir);

		vrControls.viewer.scene.view.setView(scenePos, sceneTarget);

		if(Potree.debug.message){
			this.dbgLabel.visible = true;
			this.dbgLabel.setText(Potree.debug.message);
			this.dbgLabel.scale.set(0.1, 0.1, 0.1);
			this.dbgLabel.position.copy(primary.position);
		}
	}
};

class TranslationMode{

	constructor(){
		this.controller = null;
		this.startPos = null;
		this.debugLine = null;
	}

	start(vrControls){
		this.controller = vrControls.triggered.values().next().value;
		this.startPos = vrControls.node.position.clone();
	}
	
	end(vrControls){

	}

	update(vrControls, delta){

		let start = this.controller.start.position;
		let end = this.controller.position;

		start = vrControls.toScene(start);
		end = vrControls.toScene(end);

		let diff = end.clone().sub(start);
		diff.set(-diff.x, -diff.y, -diff.z);

		let pos = new THREE.Vector3().addVectors(this.startPos, diff);

		vrControls.node.position.copy(pos);
	}

};

class RotScaleMode{

	constructor(){
		this.line = null;
		this.startState = null;
	}

	start(vrControls){
		if(!this.line){
			this.line = Potree.Utils.debugLine(
				vrControls.viewer.sceneVR, 
				new THREE.Vector3(0, 0, 0),
				new THREE.Vector3(0, 0, 0),
				0xffff00,
			);

			this.dbgLabel = new Potree.TextSprite("abc");
			this.dbgLabel.scale.set(0.1, 0.1, 0.1);
			vrControls.viewer.sceneVR.add(this.dbgLabel);
		}

		this.line.node.visible = true;

		this.startState = vrControls.node.clone();
	}

	end(vrControls){
		this.line.node.visible = false;
		this.dbgLabel.visible = false;
	}

	update(vrControls, delta){

		let start_c1 = vrControls.cPrimary.start.position.clone();
		let start_c2 = vrControls.cSecondary.start.position.clone();
		let start_center = start_c1.clone().add(start_c2).multiplyScalar(0.5);
		let start_c1_c2 = start_c2.clone().sub(start_c1);
		let end_c1 = vrControls.cPrimary.position.clone();
		let end_c2 = vrControls.cSecondary.position.clone();
		let end_center = end_c1.clone().add(end_c2).multiplyScalar(0.5);
		let end_c1_c2 = end_c2.clone().sub(end_c1);

		let d1 = start_c1_c2.length();
		let d2 = end_c1_c2.length();

		let angleStart = new THREE.Vector2(start_c1_c2.x, start_c1_c2.z).angle();
		let angleEnd = new THREE.Vector2(end_c1_c2.x, end_c1_c2.z).angle();
		let angleDiff = angleEnd - angleStart;
		
		let scale = d2 / d1;

		let node = this.startState.clone();
		node.updateMatrix();
		node.matrixAutoUpdate = false;

		let mToOrigin = new THREE.Matrix4().makeTranslation(...toScene(start_center, this.startState).multiplyScalar(-1).toArray());
		let mToStart = new THREE.Matrix4().makeTranslation(...toScene(start_center, this.startState).toArray());
		let mRotate = new THREE.Matrix4().makeRotationZ(angleDiff);
		let mScale = new THREE.Matrix4().makeScale(1 / scale, 1 / scale, 1 / scale);

		node.applyMatrix4(mToOrigin);
		node.applyMatrix4(mRotate);
		node.applyMatrix4(mScale);
		node.applyMatrix4(mToStart);

		let oldScenePos = toScene(start_center, this.startState);
		let newScenePos = toScene(end_center, node);
		let toNew = oldScenePos.clone().sub(newScenePos);
		let mToNew = new THREE.Matrix4().makeTranslation(...toNew.toArray());
		node.applyMatrix4(mToNew);

		node.matrix.decompose(node.position, node.quaternion, node.scale );

		vrControls.node.position.copy(node.position);
		vrControls.node.quaternion.copy(node.quaternion);
		vrControls.node.scale.copy(node.scale);
		vrControls.node.updateMatrix();

		{
			let scale = vrControls.node.scale.x;
			let camVR = vrControls.viewer.renderer.xr.getCamera(fakeCam);
			
			let vrPos = camVR.getWorldPosition(new THREE.Vector3());
			let vrDir = camVR.getWorldDirection(new THREE.Vector3());
			let vrTarget = vrPos.clone().add(vrDir.multiplyScalar(scale));

			let scenePos = toScene(vrPos, this.startState);
			let sceneDir = toScene(vrPos.clone().add(vrDir), this.startState).sub(scenePos);
			sceneDir.normalize().multiplyScalar(scale);
			let sceneTarget = scenePos.clone().add(sceneDir);

			vrControls.viewer.scene.view.setView(scenePos, sceneTarget);
			vrControls.viewer.setMoveSpeed(scale);
		}

		{ // update "GUI"
			this.line.set(end_c1, end_c2);

			let scale = vrControls.node.scale.x;
			this.dbgLabel.visible = true;
			this.dbgLabel.position.copy(end_center);
			this.dbgLabel.setText(`scale: 1 : ${scale.toFixed(2)}`);
			this.dbgLabel.scale.set(0.05, 0.05, 0.05);
		}

	}

};


export class VRControls extends EventDispatcher{

	constructor(viewer){
		super(viewer);

		this.viewer = viewer;

		viewer.addEventListener("vr_start", this.onStart.bind(this));
		viewer.addEventListener("vr_end", this.onEnd.bind(this));

		this.node = new THREE.Object3D();
		this.node.up.set(0, 0, 1);
		this.triggered = new Set();

		let xr = viewer.renderer.xr;

		{ // lights
			
			const light = new THREE.PointLight( 0xffffff, 5, 0, 1 );
			light.position.set(0, 2, 0);
			this.viewer.sceneVR.add(light)
		}

		this.mainMenu = null;
		this.appearanceMenu = null;
		this.measureMenu = null;
		this.attributeMenu = null;
		this._attributeRefresh = null;
		this.activeMenu = null;
		// Entradas del selector de nubes (base + nubes propias añadidas por el usuario)
		this.cloudMenuEntries = this._defaultCloudEntries();
		this._dragging = null;
		this._menuRaycaster = new THREE.Raycaster();

		// Estado de la entrada de ratón en escritorio (menú VR + modos de colocación).
		this._pickRaycaster = new THREE.Raycaster();
		this._desktopPointerNDC = new THREE.Vector2(0, 0);
		this._desktopDown = null;
		this._desktopSprayStroke = false;

		const controllerModelFactory = new XRControllerModelFactory();
		// Prefer a local copy of the webxr-input-profiles assets to avoid
		// missing-node warnings (and to prevent loading from the CDN).
		// After you download the profiles into `libs/webxr-input-profiles/profiles`
		// set the factory path to point there so the GLTF and profile JSONs match.
		controllerModelFactory.path = './libs/webxr-input-profiles/profiles';

		let sg = new THREE.SphereGeometry(1, 32, 32);
		let sm = new THREE.MeshNormalMaterial();

		{ // setup primary controller
			let controller = xr.getController(0);

			let grip = xr.getControllerGrip(0);
			grip.name = "grip(0)";

			// ADD CONTROLLERMODEL
			grip.add( controllerModelFactory.createControllerModel( grip ) );
			this.viewer.sceneVR.add(grip);

			// ADD SPHERE
			let sphere = new THREE.Mesh(sg, sm);
			sphere.scale.set(0.005, 0.005, 0.005);

			controller.add(sphere);
			controller.visible = true;
			this.viewer.sceneVR.add(controller);

			{ // ADD LINE

				let lineGeometry = new LineGeometry();

				lineGeometry.setPositions([
					0, 0, -0.15,
					0, 0, 0.05,
				]);

				let lineMaterial = new LineMaterial({
					color: 0xff0000,
					linewidth: 2,
					resolution:  new THREE.Vector2(1000, 1000),
				});

				const line = new Line2(lineGeometry, lineMaterial);

				controller.add(line);
				this._lineGeoPrimary = lineGeometry;
			}


			controller.addEventListener( 'connected', function ( event ) {
				const xrInputSource = event.data;
				controller.inputSource = xrInputSource;
				// initInfo(controller);
			});

			controller.addEventListener( 'selectstart', () => {this.onTriggerStart(controller)});
			controller.addEventListener( 'selectend', () => {this.onTriggerEnd(controller)});
			controller.addEventListener( 'squeezestart', () => {this.onSqueezeStart(controller)});
			controller.addEventListener( 'squeezeend', () => {this.onSqueezeEnd(controller)});

			this.cPrimary =  controller;

		}

		{ // setup secondary controller
			let controller = xr.getController(1);

			let grip = xr.getControllerGrip(1);

			// ADD CONTROLLER MODEL
			let model = controllerModelFactory.createControllerModel( grip );
			grip.add(model);
			this.viewer.sceneVR.add( grip );

			// ADD SPHERE
			let sphere = new THREE.Mesh(sg, sm);
			sphere.scale.set(0.005, 0.005, 0.005);
			controller.add(sphere);
			controller.visible = true;
			this.viewer.sceneVR.add(controller);

			{ // ADD LINE

				let lineGeometry = new LineGeometry();

				lineGeometry.setPositions([
					0, 0, -0.15,
					0, 0, 0.05,
				]);

				let lineMaterial = new LineMaterial({
					color: 0xff0000,
					linewidth: 2,
					resolution:  new THREE.Vector2(1000, 1000),
				});

				const line = new Line2(lineGeometry, lineMaterial);

				controller.add(line);
				this._lineGeoSecondary = lineGeometry;
			}

			controller.addEventListener( 'connected', (event) => {
				const xrInputSource = event.data;
				controller.inputSource = xrInputSource;
				this.initMenu(controller);
			});

			controller.addEventListener( 'selectstart', () => {this.onTriggerStart(controller)});
			controller.addEventListener( 'selectend', () => {this.onTriggerEnd(controller)});
			controller.addEventListener( 'squeezestart', () => {this.onSqueezeStart(controller)});
			controller.addEventListener( 'squeezeend', () => {this.onSqueezeEnd(controller)});

			this.cSecondary =  controller;
		}

		this.mode_fly = new FlyMode();
		this.mode_translate = new TranslationMode();
		this.mode_rotScale = new RotScaleMode();
		this.setMode(this.mode_fly);

		this.pointsMode = false;
		this.activeMeasurement = null;
		this.measureType = 'distance';

		// Visión de anomalías (cilindros rojos sobre las zonas de peligro)
		this.anomaliesActive = false;

		// Punto de información
		this.infoPointMode = false;
		this.infoPointMeasure = null;    // Potree.Measure (esfera + label) una vez colocado
		this.infoPreviewMeasure = null;  // Potree.Measure de la esfera fantasma mientras se apunta

		// Colocar inicio del Paseo: coloca un punto y recalcula el inicio del modo paseo
		this.walkStartMode = false;

		// Tamaño de punto reducido durante la colocación (medidas, info, clasificación)
		this._placementShrinkActive = false;
		this._savedPointSizes = null;

		// Recortado de zonas (clipping con cubo)
		this.clipMode = false;
		this.clipBoxes = [];          // [{ volume, handles: [6 meshes] }]
		this.clipMenu = null;
		this.clipTaskMenu = null;
		this._clipHandleGroup = null; // THREE.Group dentro de viewer.volumeTool.scene
		this._clipDragging = null;    // { entry, kind:'axis'|'center', ... } durante el arrastre
		this._clipHovered = null;     // tirador resaltado
		this.clipShape = 'box';       // 'box' | 'cylinder' | 'sphere' — forma a colocar
		this._clipPlaceArmed = false; // coloca una sola figura por selección de menú; se desarma tras colocar
		this.clipShapeMenu = null;    // submenú "FORMA DE ZONA" abierto desde Delimitar Zonas

		// Recorte por polígono dibujado a mano (prisma recto en la dirección de la vista)
		this.polygonMode = false;
		this._polygonPoints = [];     // puntos 3D (mundo) pintados sobre la nube, máx 8
		this._polygonPreview = null;  // Potree.Measure (contorno cerrado) de previsualización
		this._polygonCamera = null;   // cámara ortográfica capturada al empezar (define la extrusión)
		this._polygonClips = [];      // PolygonClipVolume creados, para poder borrarlos

		// Edición de classification por punto
		this.editClassMode = false;
		this.editClassMenu = null;
		this.editClassTarget = null;        // { code:int, name:string }
		this.editClassPreviewMeasure = null;
		this.editClassLog = [];             // [{x,y,z,fromCode,toCode,fromName,toName,ts}]
		this._reclassSessionStart = 0;      // índice en editClassLog donde empezó la sesión de edición actual
		this.editClassOverrides = new Map();// key: "x|y|z" en coords del pointcloud → newCode
		this._editClassProcessedNodes = new WeakSet();
		// Contexto: rejilla "Editar Clasificación" abierta desde el clip → aplicar al segmento (cajas)
		this.editClassSegmentMode = false;

		// Reclasificación en dos pasos: primero clase de ORIGEN, luego DESTINO.
		// Solo los puntos cuya clase actual == origen cambian al destino. Aplica a TODOS los modos.
		this.editClassOrigin = null;        // { code, name } | null (null = eligiendo origen)
		this.editClassTitle = null;         // sprite del título de la rejilla (se actualiza por paso)
		this.editClassHint = null;          // sprite de la pista de la rejilla

		// Modo de reclasificación por apuntado: 'point' (punto por punto) | 'spray'
		this.reclassMode = 'point';
		this.reclassModeMenu = null;

		this.perfMenu = null;               // submenú "Rendimiento" (toggle + slider de tamaño)
		this.perfHUD = null;                // plano 3D que muestra el panel de stats DENTRO del casco
		this.editClassSprayActive = false;  // true mientras se mantiene el gatillo en spray
		this.editClassSprayRadius = 1.0;    // radio del pincel, en unidades de la nube (m). Mín 1.0 m (mostrado como 10 cm)
		this.editClassBrushPreview = null;  // esfera de previsualización del pincel
		this._editClassSprayHapticTs = 0;   // throttle del feedback háptico

		document.addEventListener('vr-mode-select', (e) => {
			if(e.detail.mode !== 3 && this.pointsMode) this._finishMeasurement();
			this.pointsMode = (e.detail.mode === 3);
			if(this.infoPointMode){ this.infoPointMode = false; this._clearInfoPreview(); }
			if(this.walkStartMode){ this.walkStartMode = false; this._clearInfoPreview(); }
			if(this.editClassMode){ this._finishEditClassSession(); }
			if(this.editClassSegmentMode){ this.editClassSegmentMode = false; }
			this.editClassSprayActive = false;
		});

		// La página añade una nube propia al selector (desde el formulario de la barra lateral).
		document.addEventListener('vr-register-cloud', (e) => {
			this._addCloudToSelector(e.detail.id, e.detail.name);
		});
	}

	createSlider(label, min, max){

		let sg = new THREE.SphereGeometry(1, 8, 8);
		let cg = new THREE.CylinderGeometry(1, 1, 1, 8);
		let matHandle = new THREE.MeshBasicMaterial({color: 0xff0000});
		let matScale = new THREE.MeshBasicMaterial({color: 0xff4444});
		let matValue = new THREE.MeshNormalMaterial();

		let node = new THREE.Object3D("slider");
		let nLabel = new Potree.TextSprite(`${label}: 0`);
		let nMax = new THREE.Mesh(sg, matHandle);
		let nMin = new THREE.Mesh(sg, matHandle);
		let nValue = new THREE.Mesh(sg, matValue);
		let nScale = new THREE.Mesh(cg, matScale);

		nLabel.scale.set(0.2, 0.2, 0.2);
		nLabel.position.set(0, 0.35, 0);

		nMax.scale.set(0.02, 0.02, 0.02);
		nMax.position.set(0, 0.25, 0);

		nMin.scale.set(0.02, 0.02, 0.02);
		nMin.position.set(0, -0.25, 0);

		nValue.scale.set(0.02, 0.02, 0.02);
		nValue.position.set(0, 0, 0);

		nScale.scale.set(0.005, 0.5, 0.005);

		node.add(nLabel);
		node.add(nMax);
		node.add(nMin);
		node.add(nValue);
		node.add(nScale);

		return node;
	}

	createInfo(){ 

		let texture = new THREE.TextureLoader().load(`${Potree.resourcePath}/images/vr_controller_help.jpg`);
		let plane = new THREE.PlaneBufferGeometry(1, 1, 1, 1);
		let infoMaterial = new THREE.MeshBasicMaterial({map: texture});
		let infoNode = new THREE.Mesh(plane, infoMaterial);

		return infoNode;
	}

	initMenu(controller){
		if(this.mainMenu) return;
		this._createVRMenu();
		this._createAppearanceMenu();
		this._createMeasureMenu();
		this._createAttributeMenu();
		this._createCloudMenu();
		this._createClipMenu();
		this._createClipTaskMenu();
		this._createClipShapeMenu();
		this._createEditClassMenu();
		this._createReclassModeMenu();
		this._createPerfMenu();
	}

	_createVRMenu(){
		const group = new THREE.Group();
		group.name = 'vr-mode-menu';
		group.visible = false;

		// Fondo del panel (ampliado para una fila más: botón "Rendimiento")
		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x0d1b2e,
			transparent: true,
			opacity: 0.88,
			side: THREE.DoubleSide,
		});
		const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 1.24), bgMat);
		bg.position.set(0, -0.07, 0);
		group.add(bg);

		// Título
		const title = this._createMenuTitle('MODO DE VISIÓN');
		title.scale.set(0.093, 0.093, 0.093);
		title.position.set(0, 0.34, 0.002);
		group.add(title);

		// Grid 4x2: Paseo | Aéreo / Medidas | Apariencia / Atributo | Recortado / Cambiar nube | Editar Clasif.
		const btnWalk = this._createMenuButton('Modo Paseo', 2);
		btnWalk.position.set(-0.17, 0.16, 0.002);
		group.add(btnWalk);

		const btnGod = this._createMenuButton('Modo Aéreo', 1);
		btnGod.position.set(0.17, 0.16, 0.002);
		group.add(btnGod);

		const btnPoints = this._createMenuButton('Activar Colocar\nMedidas', 'OPEN_MEASURE');
		btnPoints.position.set(-0.17, 0.0, 0.002);
		group.add(btnPoints);

		const btnAppearance = this._createMenuButton('Apariencia', 'OPEN_APPEARANCE');
		btnAppearance.position.set(0.17, 0.0, 0.002);
		group.add(btnAppearance);

		const btnAttribute = this._createMenuButton('Atributo', 'OPEN_ATTRIBUTE');
		btnAttribute.position.set(-0.17, -0.16, 0.002);
		group.add(btnAttribute);

		const btnClip = this._createMenuButton('Recortado de\nZonas', 'OPEN_CLIP');
		btnClip.position.set(0.17, -0.16, 0.002);
		group.add(btnClip);

		const btnChangeCloud = this._createMenuButton('Cambiar nube\nde puntos', 'OPEN_CLOUD_MENU');
		btnChangeCloud.position.set(-0.17, -0.32, 0.002);
		group.add(btnChangeCloud);

		const btnEditClass = this._createMenuButton('Editar\nClasificación', 'OPEN_EDIT_CLASS');
		btnEditClass.position.set(0.17, -0.32, 0.002);
		group.add(btnEditClass);

		const btnAnomalies = this._createMenuButton('Ver\nAnomalías', 'TOGGLE_ANOMALIES');
		btnAnomalies.position.set(-0.17, -0.46, 0.002);
		group.add(btnAnomalies);

		const btnWalkStart = this._createMenuButton('Colocar inicio\ndel Paseo', 'PLACE_WALK_START');
		btnWalkStart.position.set(0.17, -0.46, 0.002);
		group.add(btnWalkStart);

		const btnPerf = this._createMenuButton('Opciones ventana\nde rendimiento', 'OPEN_PERF', { width: 0.42, canvasW: 360 });
		btnPerf.position.set(0, -0.60, 0.002);
		group.add(btnPerf);

		group.userData.interactives = [btnWalk, btnGod, btnPoints, btnAppearance, btnAttribute, btnClip, btnChangeCloud, btnEditClass, btnAnomalies, btnWalkStart, btnPerf];
		this.viewer.sceneVR.add(group);
		this.mainMenu = group;
		window.vrMenu = group;
	}

	_createMenuButton(label, modeId, opts){
		opts = opts || {};
		const canvas = document.createElement('canvas');
		canvas.width = opts.canvasW || 256;
		canvas.height = opts.canvasH || 128;
		this._drawButtonCanvas(canvas, label, false);

		const tex = new THREE.CanvasTexture(canvas);
		const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(opts.width || 0.28, opts.height || 0.14), mat);
		mesh.userData = {
			modeId, label, canvas, tex, hovered: false,
			redraw: (h) => { this._drawButtonCanvas(canvas, label, h); tex.needsUpdate = true; },
		};
		return mesh;
	}

	_drawButtonCanvas(canvas, label, highlighted){
		const ctx = canvas.getContext('2d');
		const W = canvas.width, H = canvas.height;
		ctx.clearRect(0, 0, W, H);
		ctx.fillStyle = highlighted ? '#2255bb' : '#162538';
		ctx.fillRect(0, 0, W, H);
		ctx.strokeStyle = highlighted ? '#88ccff' : '#3a6090';
		ctx.lineWidth = 5;
		ctx.strokeRect(3, 3, W - 6, H - 6);
		ctx.fillStyle = '#ffffff';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';

		const lines = label.split('\n');
		if(lines.length === 1){
			ctx.font = 'bold 34px Arial, sans-serif';
			ctx.fillText(label, W / 2, H / 2);
		} else {
			ctx.font = 'bold 26px Arial, sans-serif';
			const lineH = 34;
			const startY = H / 2 - ((lines.length - 1) * lineH) / 2;
			lines.forEach((line, i) => ctx.fillText(line, W / 2, startY + i * lineH));
		}
	}

	// Cartel de título de un menú: texto blanco liso en Arial negrita (sin caja
	// ni contorno), igual al estilo del texto de los botones. Es un plane mesh
	// ESTÁTICO (no billboard: no gira hacia la cámara, queda fijo en el panel).
	// Mantiene la convención de escala anterior (geometría a canvasW*0.01) para
	// que los title.scale.set(...) ya afinados en cada menú sigan siendo válidos.
	// El objeto devuelto expone setText(nuevoTexto) para títulos dinámicos.
	// opts.fontSize permite agrandar el texto (por defecto 40, > 34 del botón).
	_createMenuTitle(text, opts){
		opts = opts || {};
		const fontSize = opts.fontSize || 40;
		const margin = 5;

		const material = new THREE.MeshBasicMaterial({
			transparent: true, depthTest: false, depthWrite: false });
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
		mesh.renderOrder = 999;

		const render = (str) => {
			const font = 'bold ' + fontSize + 'px Arial, sans-serif';

			// medir el texto para dimensionar el canvas
			const measureCtx = document.createElement('canvas').getContext('2d');
			measureCtx.font = font;
			const textWidth = measureCtx.measureText(str).width;

			const canvas = document.createElement('canvas');
			canvas.width = Math.ceil(textWidth + 2 * margin);
			canvas.height = Math.ceil(fontSize * 1.4 + 2 * margin);

			const ctx = canvas.getContext('2d');
			ctx.clearRect(0, 0, canvas.width, canvas.height); // fondo transparente
			ctx.font = font;
			ctx.fillStyle = '#ffffff';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(str, canvas.width / 2, canvas.height / 2);

			const texture = new THREE.Texture(canvas);
			texture.minFilter = THREE.LinearFilter;
			texture.magFilter = THREE.LinearFilter;
			texture.needsUpdate = true;

			if(material.map) material.map.dispose();
			material.map = texture;
			material.needsUpdate = true;

			mesh.geometry.dispose();
			mesh.geometry = new THREE.PlaneGeometry(canvas.width * 0.01, canvas.height * 0.01);
		};
		render(text);

		const obj = new THREE.Object3D();
		obj.add(mesh);
		obj.setText = (newText) => render(newText);
		return obj;
	}


	_setLaserLength(long){
		const far = long ? -3.0 : -0.15;
		const positions = [0, 0, far, 0, 0, 0.05];
		if(this._lineGeoPrimary) this._lineGeoPrimary.setPositions(positions);
		if(this._lineGeoSecondary) this._lineGeoSecondary.setPositions(positions);
	}

	_createSmallButton(symbol){
		const canvas = document.createElement('canvas');
		canvas.width = 64; canvas.height = 64;
		this._drawSmallButtonCanvas(canvas, symbol, false);
		const tex = new THREE.CanvasTexture(canvas);
		const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.045, 0.045), mat);
		mesh.userData = {
			symbol, canvas, tex, hovered: false,
			redraw: (h) => { this._drawSmallButtonCanvas(canvas, symbol, h); tex.needsUpdate = true; },
		};
		return mesh;
	}

	_drawSmallButtonCanvas(canvas, symbol, highlighted){
		const ctx = canvas.getContext('2d');
		ctx.clearRect(0, 0, 64, 64);
		ctx.fillStyle = highlighted ? '#2255bb' : '#162538';
		ctx.fillRect(0, 0, 64, 64);
		ctx.strokeStyle = highlighted ? '#88ccff' : '#3a6090';
		ctx.lineWidth = 4;
		ctx.strokeRect(2, 2, 60, 60);
		ctx.fillStyle = '#ffffff';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.font = 'bold 36px Arial, sans-serif';
		ctx.fillText(symbol, 32, 32);
	}

	_drawRadioButtonCanvas(canvas, label, hovered, selected){
		const ctx = canvas.getContext('2d');
		const w = canvas.width, h = canvas.height;
		ctx.clearRect(0, 0, w, h);
		if(selected){
			ctx.fillStyle = hovered ? '#2a6a2a' : '#1a4a1a';
			ctx.strokeStyle = hovered ? '#66dd66' : '#44aa44';
		} else {
			ctx.fillStyle = hovered ? '#2255bb' : '#162538';
			ctx.strokeStyle = hovered ? '#88ccff' : '#3a6090';
		}
		ctx.fillRect(0, 0, w, h);
		ctx.lineWidth = 5;
		ctx.strokeRect(3, 3, w - 6, h - 6);
		ctx.fillStyle = '#ffffff';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.font = 'bold 28px Arial, sans-serif';
		ctx.fillText(label, w / 2, h / 2);
	}

	_createRadioGroupWidget({ options, getValue, setValue }){
		const group = new THREE.Group();
		const meshes = [];

		const refreshAll = () => {
			const current = getValue();
			meshes.forEach(m => {
				this._drawRadioButtonCanvas(m.userData.canvas, m.userData.label, m.userData.hovered, m.userData.radioValue === current);
				m.userData.tex.needsUpdate = true;
			});
		};

		const nRows = Math.ceil(options.length / 2);
		const rowSpacing = options.length <= 2 ? 0 : 0.12;
		const startY = (nRows - 1) * rowSpacing / 2;

		const initialValue = getValue();

		options.forEach(({ label, value }, i) => {
			const canvas = document.createElement('canvas');
			canvas.width = 256;
			canvas.height = 100;
			this._drawRadioButtonCanvas(canvas, label, false, value === initialValue);
			const tex = new THREE.CanvasTexture(canvas);
			const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
			const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.10), mat);
			const row = Math.floor(i / 2);
			const col = i % 2;
			const isLastOdd = (options.length % 2 !== 0) && (i === options.length - 1);
			const x = isLastOdd ? 0 : (col === 0 ? -0.16 : 0.16);
			const y = startY - row * rowSpacing;
			mesh.position.set(x, y, 0.001);
			mesh.userData = {
				kind: 'radio',
				radioValue: value,
				label,
				canvas,
				tex,
				hovered: false,
				setValue: (v) => { setValue(v); refreshAll(); },
				redraw: (h) => {
					const current = getValue();
					this._drawRadioButtonCanvas(canvas, label, h, value === current);
					tex.needsUpdate = true;
				},
			};
			meshes.push(mesh);
			group.add(mesh);
		});

		refreshAll();
		return { group, interactives: meshes, refreshAll };
	}

	// ¿Estamos en escritorio (sin sesión XR activa)? Las ramas específicas de desktop
	// van guardadas por este helper para no alterar el comportamiento en VR.
	_isDesktop(){
		return !this.viewer.renderer.xr.isPresenting;
	}

	// Actualiza el estado de hover (resaltado) de los botones interactivos del menú a
	// partir de los impactos del raycaster. Reutilizado por el bucle update() de VR y
	// por la entrada de ratón en escritorio.
	_applyMenuHover(hits, interactives){
		for(const btn of interactives){
			const isHovered = hits.length > 0 && hits[0].object === btn;
			if(btn.userData.hovered !== isHovered){
				btn.userData.hovered = isHovered;
				if(btn.userData.redraw) btn.userData.redraw(isHovered);
			}
		}
	}

	toggleMenu(){
		// En escritorio el menú nunca se construyó (initMenu sólo se dispara al conectar
		// un mando), así que lo construimos de forma perezosa la primera vez y enlazamos
		// la entrada de ratón.
		if(this._isDesktop() && !this.mainMenu){
			this.initMenu();
			this._initDesktopInput();
		}
		if(!this.mainMenu) return;
		if(this.activeMenu){
			this._hideAllMenus();
			if(this._isDesktop()) this._setDesktopNavFrozen(false);
		} else {
			this._showMenu(this.mainMenu);
			if(this._isDesktop()) this._setDesktopNavFrozen(true);
		}
	}

	// Congela/restaura la navegación de cámara en escritorio (menú abierto o trazo de spray).
	// Se quita/agrega el listener del InputHandler porque los controles no respetan el flag
	// `enabled` en sus handlers de arrastre.
	_setDesktopNavFrozen(active){
		if(active === !!this._desktopFrozen) return;
		this._desktopFrozen = active;
		const ih = this.viewer.inputHandler;
		const controls = this.viewer.controls;
		if(!ih || !controls) return;
		if(active){
			ih.removeInputListener(controls);
		}else{
			ih.addInputListener(controls);
		}
	}

	// ¿Hay algún modo de colocación activo (recorte, polígono, reclasificación, medidas)?
	_anyPlacementModeActive(){
		return !!(this.clipMode || this.polygonMode || this.editClassMode || this.pointsMode || this.infoPointMode || this.walkStartMode);
	}

	// Enlaza (una sola vez) los listeners de ratón que conducen el menú VR y los modos de
	// colocación en escritorio. Modelo: la navegación de cámara sigue libre; un "tap" (clic sin
	// arrastre) ejecuta la acción; el clic derecho (tap) termina/sale del modo (≈ squeeze).
	_initDesktopInput(){
		if(this._desktopInputBound) return;
		this._desktopInputBound = true;
		const dom = this.viewer.renderer.domElement;

		const updateNDC = (ev) => {
			const rect = dom.getBoundingClientRect();
			this._desktopPointerNDC.set(
				((ev.clientX - rect.left) / rect.width) * 2 - 1,
				-((ev.clientY - rect.top) / rect.height) * 2 + 1,
			);
		};

		const TAP_MAX_PX = 5;
		const isTap = (ev) => {
			if(!this._desktopDown) return false;
			const dx = ev.clientX - this._desktopDown.x;
			const dy = ev.clientY - this._desktopDown.y;
			return Math.hypot(dx, dy) <= TAP_MAX_PX;
		};

		dom.addEventListener('mousemove', (ev) => {
			if(!this._isDesktop()) return;
			updateNDC(ev);
			// Hover de botones del menú (cuando hay menú abierto).
			if(this.activeMenu && this.activeMenu.visible){
				const interactives = this.activeMenu.userData.interactives ?? [];
				if(interactives.length === 0) return;
				const cam = this.viewer.scene.getActiveCamera();
				this._pickRaycaster.setFromCamera(this._desktopPointerNDC, cam);
				const hits = this._pickRaycaster.intersectObjects(interactives);
				this._applyMenuHover(hits, interactives);
			}
		});

		// ¿Estamos en reclasificación spray, fuera del menú? (botón izq. = pintar con cámara bloqueada)
		const sprayPaintingMode = () =>
			this.editClassMode && this.reclassMode === 'spray' && !(this.activeMenu && this.activeMenu.visible);

		// Termina el trazo de spray: detiene el pintado y descongela la cámara.
		const endSprayStroke = () => {
			if(!this._desktopSprayStroke) return;
			this._desktopSprayStroke = false;
			this.onTriggerEnd(this.cPrimary);     // editClassSprayActive = false
			this._setDesktopNavFrozen(false);
		};

		dom.addEventListener('mousedown', (ev) => {
			if(!this._isDesktop()) return;
			this._desktopDown = { x: ev.clientX, y: ev.clientY, button: ev.button };

			// Spray: el botón izquierdo BLOQUEA la cámara y pinta de forma continua mientras se
			// mantiene pulsado (el pintado por-frame ocurre en _updateActiveModes siguiendo el ratón).
			if(ev.button === 0 && sprayPaintingMode()){
				this._desktopSprayStroke = true;
				this._setDesktopNavFrozen(true);
				updateNDC(ev);
				this.onTriggerStart(this.cPrimary); // editClassSprayActive = true + primera pasada
			}
		});

		dom.addEventListener('mouseup', (ev) => {
			if(!this._isDesktop()) return;

			// Fin del trazo de spray (puede haber sido un arrastre, no un tap).
			if(this._desktopSprayStroke && ev.button === 0){
				endSprayStroke();
				this._desktopDown = null;
				return;
			}

			const tap = isTap(ev);
			const button = ev.button;
			this._desktopDown = null;
			if(!tap) return;
			updateNDC(ev);

			// Clic derecho (tap) = squeeze: cierra el polígono o sale del modo activo.
			if(button === 2){
				if(this._anyPlacementModeActive()) this.onSqueezeStart(this.cPrimary);
				return;
			}
			if(button !== 0) return;

			// 1) Si hay menú abierto → despachar el botón bajo el cursor.
			if(this.activeMenu && this.activeMenu.visible){
				const interactives = this.activeMenu.userData.interactives ?? [];
				const cam = this.viewer.scene.getActiveCamera();
				this._pickRaycaster.setFromCamera(this._desktopPointerNDC, cam);
				const hits = this._pickRaycaster.intersectObjects(interactives);
				this._applyMenuHover(hits, interactives);
				this.onTriggerStart(this.cPrimary);
				this._dragging = null; // el arrastre de slider es sólo-VR; los +/− bastan en desktop
				if(!this.activeMenu) this._setDesktopNavFrozen(false);
				return;
			}

			// 2) Si hay un modo de colocación activo → un tap = una acción (colocar / reclasificar
			//    punto-por-punto / añadir vértice). Se cierra de inmediato cualquier estado de spray/drag.
			if(this._anyPlacementModeActive()){
				this.onTriggerStart(this.cPrimary);
				this.onTriggerEnd(this.cPrimary);
			}
		});

		// Seguridad: si se suelta el ratón fuera del lienzo durante un trazo de spray, terminarlo
		// igualmente para no dejar la cámara congelada.
		dom.addEventListener('mouseleave', () => {
			if(this._isDesktop()) endSprayStroke();
		});

		// Suprimir el menú contextual del navegador mientras hay un modo activo (el clic derecho
		// se usa como "salir/terminar"); el pan con arrastre derecho sigue funcionando.
		dom.addEventListener('contextmenu', (ev) => {
			if(this._isDesktop() && this._anyPlacementModeActive()) ev.preventDefault();
		});
	}

	_hideAllMenus(){
		if(this.mainMenu) this.mainMenu.visible = false;
		if(this.appearanceMenu) this.appearanceMenu.visible = false;
		if(this.measureMenu) this.measureMenu.visible = false;
		if(this.attributeMenu) this.attributeMenu.visible = false;
		if(this.cloudMenu) this.cloudMenu.visible = false;
		if(this.clipMenu) this.clipMenu.visible = false;
		if(this.clipTaskMenu) this.clipTaskMenu.visible = false;
		if(this.clipShapeMenu) this.clipShapeMenu.visible = false;
		if(this.editClassMenu) this.editClassMenu.visible = false;
		if(this.reclassModeMenu) this.reclassModeMenu.visible = false;
		if(this.perfMenu) this.perfMenu.visible = false;
		this.activeMenu = null;
		this._setLaserLength(false);
	}

	_showMenu(menu){
		this._hideAllMenus();
		if(!menu) return;
		menu.visible = true;
		this.activeMenu = menu;
		this._positionMenuInFrontOfCamera();
		this._setLaserLength(true);
	}

	_positionMenuInFrontOfCamera(){
		if(!this.activeMenu) return;

		// En escritorio no hay cámara XR: usar la cámara activa de la escena. Además, en vez
		// de lookAt (que deriva el "roll" del up del mundo y deja el panel girado/bocabajo
		// según cómo se haya orientado la cámara), copiamos la orientación de la cámara para
		// que el menú sea un billboard alineado a la pantalla: siempre recto frente al usuario.
		if(this._isDesktop()){
			const cam = this.viewer.scene.getActiveCamera();
			const pos = new THREE.Vector3();
			const quat = new THREE.Quaternion();
			cam.getWorldPosition(pos);
			cam.getWorldQuaternion(quat);
			const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
			const menuPos = pos.clone().addScaledVector(forward, 1.5);
			this.activeMenu.position.copy(menuPos);
			this.activeMenu.quaternion.copy(quat);
			return;
		}

		const camVR = this.viewer.renderer.xr.getCamera(fakeCam);
		const pos = new THREE.Vector3();
		const dir = new THREE.Vector3();
		camVR.getWorldPosition(pos);
		camVR.getWorldDirection(dir);

		const menuPos = pos.clone().addScaledVector(dir, 1.5);
		menuPos.y -= 0.05;
		this.activeMenu.position.copy(menuPos);
		this.activeMenu.lookAt(pos);
		console.log(`[VRMenu] cam=(${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}) menu=(${menuPos.x.toFixed(2)},${menuPos.y.toFixed(2)},${menuPos.z.toFixed(2)})`);
	}

	_createSliderWidget({label, min, max, step, getValue, setValue, valueFormat, labelScale}){
		valueFormat = valueFormat || ((v) => v.toFixed(0));
		labelScale = labelScale || 0.05;

		const group = new THREE.Group();

		const labelSprite = this._createMenuTitle(`${label}: ${valueFormat(getValue())}`);
		labelSprite.scale.set(labelScale, labelScale, labelScale);
		labelSprite.position.set(0, 0.055, 0.001);
		group.add(labelSprite);

		const barMat = new THREE.MeshBasicMaterial({ color: 0x223344, side: THREE.DoubleSide });
		const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.40, 0.012), barMat);
		bar.position.set(0, 0, 0.001);
		group.add(bar);

		const handleMat = new THREE.MeshBasicMaterial({ color: 0xdddddd, side: THREE.DoubleSide });
		const handle = new THREE.Mesh(new THREE.PlaneGeometry(0.025, 0.040), handleMat);
		handle.position.set(0, 0, 0.002);
		handle.userData = {
			role: 'handle', hovered: false,
			redraw: (h) => { handle.material.color.set(h ? 0x88ccff : 0xdddddd); },
		};
		group.add(handle);

		const btnMinus = this._createSmallButton('−');
		btnMinus.position.set(-0.235, 0, 0.002);
		btnMinus.userData.role = '-';
		group.add(btnMinus);

		const btnPlus = this._createSmallButton('+');
		btnPlus.position.set(0.235, 0, 0.002);
		btnPlus.userData.role = '+';
		group.add(btnPlus);

		const refreshUI = (value) => {
			const v = Math.max(min, Math.min(max, value));
			group.userData.currentValue = v;
			const t = max > min ? (v - min) / (max - min) : 0;
			handle.position.x = -0.2 + t * 0.4;
			labelSprite.setText(`${label}: ${valueFormat(v)}`);
		};

		group.userData = {
			kind: 'slider', min, max, step,
			currentValue: getValue(),
			getValue,
			setValue: (v) => { setValue(v); refreshUI(v); },
			refreshUI,
		};

		handle.userData.parentSlider = group;
		btnMinus.userData.parentSlider = group;
		btnPlus.userData.parentSlider = group;

		refreshUI(getValue());

		return { group, interactives: [handle, btnMinus, btnPlus] };
	}

	_createToggleWidget({label, getValue, setValue, labelScale}){
		labelScale = labelScale || 0.05;
		const group = new THREE.Group();

		const labelSprite = this._createMenuTitle(label);
		labelSprite.scale.set(labelScale, labelScale, labelScale);
		labelSprite.position.set(0.075, 0, 0.001);
		group.add(labelSprite);

		const canvas = document.createElement('canvas');
		canvas.width = 64; canvas.height = 64;
		const tex = new THREE.CanvasTexture(canvas);
		const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
		const box = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.04), mat);
		box.position.set(-0.075, 0, 0.001);
		group.add(box);

		const drawBox = (checked, hovered) => {
			const ctx = canvas.getContext('2d');
			ctx.clearRect(0, 0, 64, 64);
			ctx.fillStyle = hovered ? '#2255bb' : '#162538';
			ctx.fillRect(0, 0, 64, 64);
			ctx.strokeStyle = hovered ? '#88ccff' : '#3a6090';
			ctx.lineWidth = 4;
			ctx.strokeRect(2, 2, 60, 60);
			if(checked){
				ctx.strokeStyle = '#88ff88';
				ctx.lineWidth = 6;
				ctx.beginPath();
				ctx.moveTo(12, 32);
				ctx.lineTo(28, 48);
				ctx.lineTo(52, 16);
				ctx.stroke();
			}
			tex.needsUpdate = true;
		};

		drawBox(getValue(), false);

		let _checked = getValue();
		box.userData = {
			kind: 'toggle', hovered: false,
			getValue,
			setValue: (v) => { setValue(v); _checked = v; drawBox(v, box.userData.hovered); },
			toggle:   ()  => { box.userData.setValue(!_checked); },
			refreshUI: (v) => { _checked = v; drawBox(v, box.userData.hovered); },
			redraw: (h) => { box.userData.hovered = h; drawBox(_checked, h); },
		};

		return { group, interactives: [box] };
	}

	_createAppearanceMenu(){
		const group = new THREE.Group();
		group.name = 'vr-appearance-menu';
		group.visible = false;

		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x0d1b2e, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
		});
		const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.80, 1.22), bgMat);
		bg.position.set(0, 0.13, 0);
		group.add(bg);

		const title = this._createMenuTitle('APARIENCIA');
		title.scale.set(0.11, 0.11, 0.11);
		title.position.set(0, 0.62, 0.002);
		group.add(title);

		const interactives = [];

		// Slider: Point Budget
		const sliderPB = this._createSliderWidget({
			label: 'Point Budget',
			min: 100000, max: 10000000, step: 100000,
			getValue: () => this.viewer.getPointBudget(),
			setValue: (v) => this.viewer.setPointBudget(v),
			valueFormat: (v) => (v / 1000000).toFixed(1) + 'M',
			labelScale: 0.065,
		});
		sliderPB.group.position.set(0, 0.46, 0.002);
		group.add(sliderPB.group);
		interactives.push(...sliderPB.interactives);

		// Sección: Fondo
		const fondoLabel = this._createMenuTitle('FONDO');
		fondoLabel.scale.set(0.065, 0.065, 0.065);
		fondoLabel.position.set(0, 0.34, 0.002);
		group.add(fondoLabel);

		const radioFondo = this._createRadioGroupWidget({
			options: [
				{ label: 'Skybox',    value: 'skybox'   },
				{ label: 'Degradado', value: 'gradient' },
				{ label: 'Negro',     value: 'black'    },
				{ label: 'Blanco',    value: 'white'    },
			],
			getValue: () => this.viewer.getBackground(),
			setValue: (v) => this.viewer.setBackground(v),
		});
		radioFondo.group.position.set(0, 0.20, 0.002);
		group.add(radioFondo.group);
		interactives.push(...radioFondo.interactives);

		// Slider: Tamaño de punto (material.size de las nubes). 0 = diminuto: el shader lo
		// limita a minSize (~2px), igual que en los modos de colocación de medidas.
		const sliderPointSize = this._createSliderWidget({
			label: 'Tamaño de punto',
			min: 0, max: 3, step: 0.05,
			getValue: () => { const pc = this.viewer.scene.pointclouds[0]; return pc ? pc.material.size : 1; },
			setValue: (v) => { for(const pc of this.viewer.scene.pointclouds){ if(pc && pc.material) pc.material.size = v; } },
			valueFormat: (v) => v.toFixed(2),
			labelScale: 0.065,
		});
		sliderPointSize.group.position.set(0, -0.05, 0.002);
		group.add(sliderPointSize.group);
		interactives.push(...sliderPointSize.interactives);

		// Checkbox: Box (muestra las bounding boxes del octree)
		const toggleBox = this._createToggleWidget({
			label: 'Box',
			getValue: () => this.viewer.getShowBoundingBox(),
			setValue: (v) => this.viewer.setShowBoundingBox(v),
			labelScale: 0.065,
		});
		toggleBox.group.position.set(0, -0.20, 0.002);
		group.add(toggleBox.group);
		interactives.push(...toggleBox.interactives);

		// Botón Volver
		const btnBack = this._createMenuButton('← Volver', 'BACK_TO_MAIN');
		btnBack.position.set(0, -0.34, 0.002);
		group.add(btnBack);
		interactives.push(btnBack);

		group.userData.interactives = interactives;

		// Sincronización viewer → UI
		this.viewer.addEventListener('point_budget_changed', () => {
			sliderPB.group.userData.refreshUI(this.viewer.getPointBudget());
		});
		this.viewer.addEventListener('background_changed', () => {
			radioFondo.refreshAll();
		});
		this.viewer.addEventListener('show_boundingbox_changed', () => {
			toggleBox.interactives[0].userData.refreshUI(this.viewer.getShowBoundingBox());
		});

		this.viewer.sceneVR.add(group);
		this.appearanceMenu = group;
	}

	// Submenú "RENDIMIENTO": muestra/oculta la ventana de stats (FPS+CPU) y ajusta su tamaño.
	// El panel en sí es un DOM gestionado por la página (window.perfWindow, en 1_ejemplo_profe.html);
	// aquí solo está el control. El panel se ve en la pantalla espejo 2D, no dentro del casco.
	_createPerfMenu(){
		const group = new THREE.Group();
		group.name = 'vr-perf-menu';
		group.visible = false;

		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x0d1b2e, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
		});
		const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.80, 0.66), bgMat);
		bg.position.set(0, 0.04, 0);
		group.add(bg);

		const title = this._createMenuTitle('RENDIMIENTO');
		title.scale.set(0.11, 0.11, 0.11);
		title.position.set(0, 0.30, 0.002);
		group.add(title);

		const interactives = [];

		// Acceso seguro a la API global de la página (puede no existir si se abre muy pronto).
		const api = () => (typeof window !== 'undefined' ? window.perfWindow : null);

		// Checkbox: mostrar/ocultar la ventana de rendimiento.
		const toggleShow = this._createToggleWidget({
			label: 'Mostrar ventana',
			getValue: () => { const a = api(); return a ? !!a.isVisible() : false; },
			setValue: (v) => { const a = api(); if(a) a.setVisible(v); },
			labelScale: 0.065,
		});
		toggleShow.group.position.set(0, 0.13, 0.002);
		group.add(toggleShow.group);
		interactives.push(...toggleShow.interactives);

		// Slider: tamaño del panel (100%–300%). Escala vía CSS transform en la página.
		const sliderSize = this._createSliderWidget({
			label: 'Tamaño',
			min: 1, max: 3, step: 0.1,
			getValue: () => { const a = api(); return a ? a.getScale() : 1; },
			setValue: (v) => { const a = api(); if(a) a.setScale(v); },
			valueFormat: (v) => Math.round(v * 100) + '%',
			labelScale: 0.065,
		});
		sliderSize.group.position.set(0, -0.02, 0.002);
		group.add(sliderSize.group);
		interactives.push(...sliderSize.interactives);

		// Botón Volver
		const btnBack = this._createMenuButton('← Volver', 'BACK_TO_MAIN');
		btnBack.position.set(0, -0.22, 0.002);
		group.add(btnBack);
		interactives.push(btnBack);

		group.userData.interactives = interactives;

		this.viewer.sceneVR.add(group);
		this.perfMenu = group;
	}

	_createMeasureMenu(){
		const group = new THREE.Group();
		group.name = 'vr-measure-menu';
		group.visible = false;

		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x0d1b2e,
			transparent: true,
			opacity: 0.88,
			side: THREE.DoubleSide,
		});
		const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.90), bgMat);
		group.add(bg);

		const title = this._createMenuTitle('MEDIDAS');
		title.scale.set(0.093, 0.093, 0.093);
		title.position.set(0, 0.35, 0.002);
		group.add(title);

		const btnDistance = this._createMenuButton('Medir Distancias', 'MEASURE_DISTANCE');
		btnDistance.position.set(0, 0.20, 0.002);
		group.add(btnDistance);

		const btnHeight = this._createMenuButton('Medir Alturas', 'MEASURE_HEIGHT');
		btnHeight.position.set(0, 0.05, 0.002);
		group.add(btnHeight);

		const btnInfo = this._createMenuButton('Punto de Info', 'MEASURE_INFO_POINT');
		btnInfo.position.set(0, -0.10, 0.002);
		group.add(btnInfo);

		const btnDelete = this._createMenuButton('Eliminar Puntos', 'MEASURE_DELETE_ALL');
		btnDelete.position.set(0, -0.25, 0.002);
		group.add(btnDelete);

		const btnBack = this._createMenuButton('← Volver', 'BACK_TO_MAIN');
		btnBack.position.set(0, -0.39, 0.002);
		group.add(btnBack);

		group.userData.interactives = [btnDistance, btnHeight, btnInfo, btnDelete, btnBack];
		this.viewer.sceneVR.add(group);
		this.measureMenu = group;
	}

	_createClipMenu(){
		const group = new THREE.Group();
		group.name = 'vr-clip-menu';
		group.visible = false;

		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x0d1b2e, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
		});
		const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.70, 1.04), bgMat);
		group.add(bg);

		const title = this._createMenuTitle('RECORTADO DE ZONAS');
		title.scale.set(0.093, 0.093, 0.093);
		title.position.set(0, 0.42, 0.002);
		group.add(title);

		const btnDelimit = this._createMenuButton('Delimitar Zonas', 'CLIP_DELIMIT');
		btnDelimit.position.set(0, 0.28, 0.002);
		group.add(btnDelimit);

		const btnPolygon = this._createMenuButton('Dibujar Polígono', 'CLIP_POLYGON');
		btnPolygon.position.set(0, 0.14, 0.002);
		group.add(btnPolygon);

		const btnModify = this._createMenuButton('Modificar Zonas', 'OPEN_CLIP_TASK');
		btnModify.position.set(0, 0.00, 0.002);
		group.add(btnModify);

		const btnReclassify = this._createMenuButton('Reclasif.\nZona', 'OPEN_CLASS_FOR_CLIP');
		btnReclassify.position.set(0, -0.14, 0.002);
		group.add(btnReclassify);

		const btnDelete = this._createMenuButton('Eliminar Zonas', 'CLIP_DELETE');
		btnDelete.position.set(0, -0.28, 0.002);
		group.add(btnDelete);

		const btnBack = this._createMenuButton('← Volver', 'BACK_TO_MAIN');
		btnBack.position.set(0, -0.42, 0.002);
		group.add(btnBack);

		group.userData.interactives = [btnDelimit, btnPolygon, btnModify, btnReclassify, btnDelete, btnBack];
		this.viewer.sceneVR.add(group);
		this.clipMenu = group;
	}

	_createClipTaskMenu(){
		const group = new THREE.Group();
		group.name = 'vr-cliptask-menu';
		group.visible = false;

		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x0d1b2e, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
		});
		const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.62), bgMat);
		group.add(bg);

		const title = this._createMenuTitle('CLIP TASK');
		title.scale.set(0.11, 0.11, 0.11);
		title.position.set(0, 0.24, 0.002);
		group.add(title);

		const radio = this._createRadioGroupWidget({
			options: [
				{ label: 'Ninguno',       value: Potree.ClipTask.NONE },
				{ label: 'Resaltar',      value: Potree.ClipTask.HIGHLIGHT },
				{ label: 'Solo interior', value: Potree.ClipTask.SHOW_INSIDE },
				{ label: 'Solo exterior', value: Potree.ClipTask.SHOW_OUTSIDE },
			],
			getValue: () => this.viewer.getClipTask(),
			setValue: (v) => this.viewer.setClipTask(v),
		});
		radio.group.position.set(0, 0.02, 0.002);
		group.add(radio.group);
		this._clipTaskRefresh = radio.refreshAll;

		const btnBack = this._createMenuButton('← Volver', 'BACK_TO_MAIN');
		btnBack.position.set(0, -0.24, 0.002);
		group.add(btnBack);

		group.userData.interactives = [...radio.interactives, btnBack];
		this.viewer.sceneVR.add(group);
		this.clipTaskMenu = group;
	}

	_createClipShapeMenu(){
		const group = new THREE.Group();
		group.name = 'vr-clip-shape-menu';
		group.visible = false;

		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x0d1b2e, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
		});
		const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.70, 0.66), bgMat);
		group.add(bg);

		const title = this._createMenuTitle('FORMA DE ZONA');
		title.scale.set(0.093, 0.093, 0.093);
		title.position.set(0, 0.24, 0.002);
		group.add(title);

		const btnBox = this._createMenuButton('Cubo', 'CLIP_SHAPE_BOX');
		btnBox.position.set(0, 0.10, 0.002);
		group.add(btnBox);

		const btnCyl = this._createMenuButton('Cilindro', 'CLIP_SHAPE_CYLINDER');
		btnCyl.position.set(0, -0.05, 0.002);
		group.add(btnCyl);

		const btnSphere = this._createMenuButton('Esfera', 'CLIP_SHAPE_SPHERE');
		btnSphere.position.set(0, -0.20, 0.002);
		group.add(btnSphere);

		const btnBack = this._createMenuButton('← Volver', 'BACK_TO_CLIP_MENU');
		btnBack.position.set(0, -0.34, 0.002);
		group.add(btnBack);

		group.userData.interactives = [btnBox, btnCyl, btnSphere, btnBack];
		this.viewer.sceneVR.add(group);
		this.clipShapeMenu = group;
	}

	// Submenú para elegir el modo de reclasificación por apuntado (punto a punto / spray)
	// y ajustar el radio del pincel de spray. Se abre desde "Editar Clasificación".
	_createReclassModeMenu(){
		const group = new THREE.Group();
		group.name = 'vr-reclass-mode-menu';
		group.visible = false;

		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x0d1b2e, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
		});
		const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.80, 0.84), bgMat);
		group.add(bg);

		const title = this._createMenuTitle('RECLASIFICAR');
		title.scale.set(0.11, 0.11, 0.11);
		title.position.set(0, 0.32, 0.002);
		group.add(title);

		const modeBtnOpts = { width: 0.60, height: 0.15, canvasW: 520 };
		const btnPoint = this._createMenuButton('Reclasificar\npunto por punto', 'RECLASSIFY_MODE_POINT', modeBtnOpts);
		btnPoint.position.set(0, 0.17, 0.002);
		group.add(btnPoint);

		const btnSpray = this._createMenuButton('Reclasificar\nen spray', 'RECLASSIFY_MODE_SPRAY', modeBtnOpts);
		btnSpray.position.set(0, 0.01, 0.002);
		group.add(btnSpray);

		// Slider: radio del pincel de spray. Se MUESTRA en cm (10–50) pero el radio real
		// va de 1.0 m a 5.0 m (sin cambios). Mapeo lineal: 10 cm ↔ 1.0 m, 50 cm ↔ 5.0 m (cm = m·10).
		const sliderRadius = this._createSliderWidget({
			label: 'Radio spray',
			min: 10, max: 50, step: 1,
			getValue: () => this.editClassSprayRadius * 10,
			setValue: (cm) => { this.editClassSprayRadius = cm / 10; },
			valueFormat: (v) => v.toFixed(0) + ' cm',
			labelScale: 0.065,
		});
		sliderRadius.group.position.set(0, -0.17, 0.002);
		group.add(sliderRadius.group);

		const btnBack = this._createMenuButton('← Volver', 'BACK_TO_MAIN');
		btnBack.position.set(0, -0.34, 0.002);
		group.add(btnBack);

		group.userData.interactives = [btnPoint, btnSpray, ...sliderRadius.interactives, btnBack];
		this.viewer.sceneVR.add(group);
		this.reclassModeMenu = group;
	}

	_createAttributeMenu(){
		const group = new THREE.Group();
		group.name = 'vr-attribute-menu';
		group.visible = false;

		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x0d1b2e, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
		});
		const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 2.00), bgMat);
		group.add(bg);

		const title = this._createMenuTitle('ATRIBUTO');
		title.scale.set(0.11, 0.11, 0.11);
		title.position.set(0, 0.88, 0.002);
		group.add(title);

		const radio = this._createRadioGroupWidget({
			options: [
				{ label: 'RGBA',          value: 'rgba'               },
				{ label: 'Clasificación', value: 'classification'     },
				{ label: 'Intensidad',    value: 'intensity gradient' },
				{ label: 'Elevación',     value: 'elevation'          },
				{ label: 'Nivel Detalle', value: 'level of detail'    },
				{ label: 'Tiempo GPS',    value: 'gps-time'           },
				{ label: 'N. Retornos',   value: 'number of returns'  },
			],
			getValue: () => this._getActiveAttribute(),
			setValue: (v) => { this._applyAttribute(v); this._buildAttrControls(v); },
		});
		radio.group.position.set(0, 0.54, 0.002);
		group.add(radio.group);
		this._attributeRefresh = radio.refreshAll;

		const btnBack = this._createMenuButton('← Volver', 'BACK_TO_MAIN');
		btnBack.position.set(0, -0.90, 0.002);
		group.add(btnBack);

		// Región de controles que se reconstruye según el atributo seleccionado
		this._attrControls = new THREE.Group();
		group.add(this._attrControls);
		this._attrRadioInteractives = radio.interactives;
		this._attrBackBtn = btnBack;

		group.userData.interactives = [...radio.interactives, btnBack];
		this.viewer.sceneVR.add(group);
		this.attributeMenu = group;
	}

	// Nubes base del selector (las propias del usuario se añaden con _addCloudToSelector).
	_defaultCloudEntries(){
		return [
			{ label: 'Tramo A\n563.4 MB', cloud: 1 },
			{ label: 'Tramo B\n467.58 MB', cloud: 2 },
			{ label: 'Tramo C\n498.86 MB', cloud: 3 },
			{ label: 'Tramo D\n672.63 MB', cloud: 5 },
			{ label: 'Corredor\n(A+B+C)', cloud: 'corredor' },
			{ label: 'Gran Corredor\n5.0 GB', cloud: 'gran_corredor' },
			{ label: 'Paseo Garañón\n1011 MB', cloud: 'gran_corredor_2' },
			{ label: 'Red Eléctrica\ncon Anomalías\n319 MB', cloud: 'anomalias' },
		];
	}

	_createCloudMenu(){
		const group = new THREE.Group();
		group.name = 'vr-cloud-menu';
		group.visible = false;
		this.viewer.sceneVR.add(group);
		this.cloudMenu = group;
		this._buildCloudMenuContents();
	}

	// (Re)construye el contenido del selector a partir de this.cloudMenuEntries. El panel se
	// dimensiona según el número de nubes, de modo que las nubes propias del usuario aparecen
	// como botones más, junto a las base.
	_buildCloudMenuContents(){
		const group = this.cloudMenu;
		if(!group) return;

		// Liberar y quitar el contenido anterior
		for(const child of group.children.slice()){
			group.remove(child);
			if(child.material){
				if(child.material.map) child.material.map.dispose();
				child.material.dispose();
			}
			if(child.geometry) child.geometry.dispose();
		}

		const entries = this.cloudMenuEntries || (this.cloudMenuEntries = this._defaultCloudEntries());
		const xs = [-0.17, 0.17];
		const startY = 0.16;   // primera fila de botones
		const rowH = 0.145;
		const nRows = Math.max(1, Math.ceil(entries.length / 2));
		const backY = startY - nRows * rowH - 0.02;
		const titleY = startY + 0.18;

		// Fondo dimensionado al contenido
		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x0d1b2e, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
		});
		const topEdge = titleY + 0.06;
		const bottomEdge = backY - 0.08;
		const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.64, topEdge - bottomEdge), bgMat);
		bg.position.set(0, (topEdge + bottomEdge) / 2, 0);
		group.add(bg);

		const title = this._createMenuTitle('NUBE DE PUNTOS');
		title.scale.set(0.093, 0.093, 0.093);
		title.position.set(0, titleY, 0.002);
		group.add(title);

		const btns = entries.map((entry, i) => {
			const col = i % 2, row = Math.floor(i / 2);
			const btn = this._createMenuButton(entry.label, 'SELECT_CLOUD');
			btn.userData.cloudId = entry.cloud;
			btn.position.set(xs[col], startY - row * rowH, 0.002);
			group.add(btn);
			return btn;
		});

		const btnBack = this._createMenuButton('← Volver', 'BACK_TO_MAIN');
		btnBack.position.set(0, backY, 0.002);
		group.add(btnBack);

		group.userData.interactives = [...btns, btnBack];
	}

	// Añade una nube propia (URL) al selector con la etiqueta `name`. Si el menú ya existe lo
	// reconstruye en vivo; si aún no, quedará incluida cuando se cree.
	_addCloudToSelector(id, name){
		if(!this.cloudMenuEntries) this.cloudMenuEntries = this._defaultCloudEntries();
		if(this.cloudMenuEntries.some(e => e.cloud === id)) return; // evitar duplicados
		let label = (name || 'Nube').trim();
		if(label.length > 16) label = label.slice(0, 15) + '…';
		this.cloudMenuEntries.push({ label, cloud: id });
		if(this.cloudMenu) this._buildCloudMenuContents();
	}

	_createEditClassMenu(){
		const group = new THREE.Group();
		group.name = 'vr-edit-class-menu';
		group.visible = false;

		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x0d1b2e, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
		});
		const bg = new THREE.Mesh(new THREE.PlaneGeometry(1.20, 1.45), bgMat);
		group.add(bg);

		const title = this._createMenuTitle('EDITAR CLASIFICACIÓN');
		title.scale.set(0.093, 0.093, 0.093);
		title.position.set(0, 0.62, 0.002);
		group.add(title);
		this.editClassTitle = title;

		const hint = this._createMenuTitle('Elige una clase, apunta y pulsa trigger');
		hint.scale.set(0.093, 0.093, 0.093);
		hint.position.set(0, 0.53, 0.002);
		group.add(hint);
		this.editClassHint = hint;

		// Lista de clases del ClassificationScheme DEFAULT (códigos numéricos)
		const scheme = this.viewer.classifications;
		const codes = Object.keys(scheme)
			.filter(k => k !== 'DEFAULT' && !Number.isNaN(Number(k)))
			.map(k => Number(k))
			.sort((a, b) => a - b);

		const interactives = [];
		const COLS = 2;
		const ROW_H = 0.145;
		const Y0 = 0.40;
		const btnOpts = { width: 0.52, height: 0.14, canvasW: 464 };
		codes.forEach((code, i) => {
			const cls = scheme[code];
			const name = cls && cls.name ? cls.name : ('clase ' + code);
			const label = `${code}: ${name}`;
			const btn = this._createMenuButton(label, 'EDIT_CLASS_SET_TARGET', btnOpts);
			btn.userData.classCode = code;
			btn.userData.className = name;
			const col = i % COLS;
			const row = Math.floor(i / COLS);
			const x = col === 0 ? -0.29 : 0.29;
			const y = Y0 - row * ROW_H;
			btn.position.set(x, y, 0.002);
			group.add(btn);
			interactives.push(btn);
		});

		// Botón "default" (el DEFAULT real de Potree): como ORIGEN selecciona los puntos cuya clase
		// NO está nombrada en el esquema (los que se pintan con el color default). No vale como DESTINO.
		const btnDefault = this._createMenuButton('default', 'EDIT_CLASS_SET_TARGET', btnOpts);
		btnDefault.userData.realDefault = true;
		{
			const di = codes.length;
			const dCol = di % COLS;
			const dRow = Math.floor(di / COLS);
			btnDefault.position.set(dCol === 0 ? -0.29 : 0.29, Y0 - dRow * ROW_H, 0.002);
		}
		group.add(btnDefault);
		interactives.push(btnDefault);

		// Botón "Cualquiera": como ORIGEN reclasifica TODOS los puntos (sin filtrar por clase).
		// Útil para reclasificar una zona entera o cualquier punto apuntado. No vale como DESTINO.
		const btnAny = this._createMenuButton('Cualquiera', 'EDIT_CLASS_SET_TARGET', btnOpts);
		btnAny.userData.anyOrigin = true;
		btnAny.position.set(0, -0.475, 0.002);
		group.add(btnAny);
		interactives.push(btnAny);

		// Botón "Volver" (los cambios de clasificación ya se guardan solos en .json al terminar)
		const btnBack = this._createMenuButton('← Volver', 'BACK_TO_MAIN',
			{ width: 0.40, height: 0.14, canvasW: 360 });
		btnBack.position.set(0, -0.625, 0.002);
		group.add(btnBack);
		interactives.push(btnBack);

		group.userData.interactives = interactives;
		this.viewer.sceneVR.add(group);
		this.editClassMenu = group;
	}

	_buildAttrControls(attr){
		const region = this._attrControls;
		if(!region) return;
		region.clear();
		const interactives = [];

		if(attr === 'rgba' || attr === 'intensity gradient'){
			const p = (attr === 'rgba')
				? { g: 'rgbGamma', b: 'rgbBrightness', c: 'rgbContrast' }
				: { g: 'intensityGamma', b: 'intensityBrightness', c: 'intensityContrast' };
			const mk = (label, prop, min, max, def) => this._createSliderWidget({
				label, min, max, step: 0.01,
				getValue: () => { const pc = this.viewer.scene.pointclouds[0]; return pc ? pc.material[prop] : def; },
				setValue: (v) => { for(const pc of this.viewer.scene.pointclouds) pc.material[prop] = v; },
				valueFormat: (v) => v.toFixed(2),
				labelScale: 0.065,
			});
			const rows = [
				{ w: mk('Gamma',     p.g,  0, 4, 1), y:  0.00 },
				{ w: mk('Brillo',    p.b, -1, 1, 0), y: -0.28 },
				{ w: mk('Contraste', p.c, -1, 1, 0), y: -0.56 },
			];
			for(const { w, y } of rows){
				w.group.position.set(0, y, 0.002);
				region.add(w.group);
				interactives.push(...w.interactives);
			}
		}else if(attr === 'classification'){
			let y = 0.20;
			for(const code of Object.keys(this.viewer.classifications)){
				const row = this._createClassRow(code);
				row.group.position.set(0, y, 0.002);
				region.add(row.group);
				interactives.push(...row.interactives);
				y -= 0.086;
			}
		}

		this.attributeMenu.userData.interactives = [...this._attrRadioInteractives, ...interactives, this._attrBackBtn];
	}

	_createClassRow(code){
		const cls = this.viewer.classifications[code];
		const group = new THREE.Group();

		// Checkbox de visibilidad (kind 'toggle' → ya soportado por onTriggerStart)
		const cbCanvas = document.createElement('canvas');
		cbCanvas.width = 64; cbCanvas.height = 64;
		const cbTex = new THREE.CanvasTexture(cbCanvas);
		const cb = new THREE.Mesh(
			new THREE.PlaneGeometry(0.06, 0.06),
			new THREE.MeshBasicMaterial({ map: cbTex, transparent: true, side: THREE.DoubleSide }));
		cb.position.set(-0.36, 0, 0.001);
		const drawCb = (checked, hovered) => {
			const ctx = cbCanvas.getContext('2d');
			ctx.clearRect(0, 0, 64, 64);
			ctx.fillStyle = hovered ? '#2255bb' : '#162538';
			ctx.fillRect(0, 0, 64, 64);
			ctx.strokeStyle = hovered ? '#88ccff' : '#3a6090';
			ctx.lineWidth = 4; ctx.strokeRect(2, 2, 60, 60);
			if(checked){
				ctx.strokeStyle = '#88ff88'; ctx.lineWidth = 6;
				ctx.beginPath(); ctx.moveTo(12, 32); ctx.lineTo(28, 48); ctx.lineTo(52, 16); ctx.stroke();
			}
			cbTex.needsUpdate = true;
		};
		drawCb(cls.visible, false);
		cb.userData = {
			kind: 'toggle', hovered: false,
			toggle: () => {
				const v = !this.viewer.classifications[code].visible;
				this.viewer.setClassificationVisibility(code, v);
				drawCb(v, cb.userData.hovered);
			},
			redraw: (h) => { cb.userData.hovered = h; drawCb(this.viewer.classifications[code].visible, h); },
		};
		group.add(cb);

		const label = this._createMenuTitle(cls.name || ('clase ' + code));
		label.scale.set(0.097, 0.097, 0.097);
		label.position.set(0, 0, 0.001);
		group.add(label);

		// Botón de color: cicla la paleta fija
		const colMat = new THREE.MeshBasicMaterial({
			color: new THREE.Color(cls.color[0], cls.color[1], cls.color[2]), side: THREE.DoubleSide });
		const colBtn = new THREE.Mesh(new THREE.PlaneGeometry(0.075, 0.055), colMat);
		colBtn.position.set(0.36, 0, 0.001);
		colBtn.userData = {
			kind: 'classcolor', hovered: false, colorIdx: -1,
			onClick: () => {
				const ud = colBtn.userData;
				ud.colorIdx = (ud.colorIdx + 1) % CLASS_COLOR_PALETTE.length;
				const col = CLASS_COLOR_PALETTE[ud.colorIdx];
				this.viewer.classifications[code].color = [col[0], col[1], col[2], 1];
				colMat.color.setRGB(col[0], col[1], col[2]);
			},
			redraw: () => {},
		};
		group.add(colBtn);

		return { group, interactives: [cb, colBtn] };
	}

	_getActiveAttribute(){
		const pc = this.viewer.scene.pointclouds[0];
		return pc ? pc.material.activeAttributeName : 'rgba';
	}

	_applyAttribute(value){
		for(const pc of this.viewer.scene.pointclouds){
			const m = pc.material;
			if(value === 'intensity gradient'){
				const attr = pc.getAttribute('intensity');
				if(attr && attr.range) m.intensityRange = [attr.range[0], attr.range[1]];
			}
			m.activeAttributeName = value;
		}
	}

	_getRightController(){
		for(const c of [this.cPrimary, this.cSecondary]){
			if(c.inputSource && c.inputSource.handedness === 'right') return c;
		}
		return null;
	}

	_getLeftController(){
		for(const c of [this.cPrimary, this.cSecondary]){
			if(c.inputSource && c.inputSource.handedness === 'left') return c;
		}
		return null;
	}

	// Gira la vista (yaw) alrededor del eje vertical que pasa por la cabeza del
	// usuario, rotando el nodo del mundo. Mismo patrón que RotScaleMode.
	rotateView(angle){
		let node = this.node;
		let camVR = this.viewer.renderer.xr.getCamera(fakeCam);
		let vrPos = camVR.getWorldPosition(new THREE.Vector3());
		let pivot = toScene(vrPos, node);

		node.updateMatrix();
		node.matrixAutoUpdate = false;
		node.applyMatrix4(new THREE.Matrix4().makeTranslation(...pivot.clone().multiplyScalar(-1).toArray()));
		node.applyMatrix4(new THREE.Matrix4().makeRotationZ(angle));
		node.applyMatrix4(new THREE.Matrix4().makeTranslation(...pivot.toArray()));
		node.matrix.decompose(node.position, node.quaternion, node.scale);
		node.matrixAutoUpdate = true;
		node.updateMatrix();
	}

	toScene(vec){
		let camVR = this.getCamera();

		let mat = camVR.matrixWorld;
		let result = vec.clone().applyMatrix4(mat);

		return result;
	}

	toVR(vec){
		let camVR = this.getCamera();

		let mat = camVR.matrixWorld.clone();
		mat.invert();
		let result = vec.clone().applyMatrix4(mat);

		return result;
	}

	setMode(mode){

		if(this.mode === mode){
			return;
		}

		if(this.mode){
			this.mode.end(this);
		}

		for(let controller of [this.cPrimary, this.cSecondary]){

			let start = {
				position: controller.position.clone(),
				rotation: controller.rotation.clone(),
			};

			controller.start = start;
		}
		
		this.mode = mode;
		this.mode.start(this);
	}

	onTriggerStart(controller){
		if(this.activeMenu && this.activeMenu.visible){
			const interactives = this.activeMenu.userData.interactives ?? [];
			const hovered = interactives.find(btn => btn.userData.hovered);

			if(hovered){
				const ud = hovered.userData;

				// Modo estándar de visión (numérico)
				if(typeof ud.modeId === 'number'){
					document.dispatchEvent(new CustomEvent('vr-mode-select', { detail: { mode: ud.modeId } }));
					this._hideAllMenus();
					return;
				}

				// Navegación entre menús
				if(ud.modeId === 'OPEN_APPEARANCE'){
					this._showMenu(this.appearanceMenu);
					return;
				}
				if(ud.modeId === 'OPEN_PERF'){
					this._showMenu(this.perfMenu);
					return;
				}
				if(ud.modeId === 'BACK_TO_MAIN'){
					// En la rejilla de clases, si ya se eligió ORIGEN, "Volver" regresa a elegir origen
					if(this.activeMenu === this.editClassMenu && this.editClassOrigin){
						this.editClassOrigin = null;
						this._refreshEditClassStep();
						return;
					}
					// Si la rejilla "Editar Clasif." se abrió desde el clip, volver al clip y limpiar el contexto
					if(this.editClassSegmentMode){
						this.editClassSegmentMode = false;
						this._showMenu(this.clipMenu);
					}else{
						this._showMenu(this.mainMenu);
					}
					return;
				}
				if(ud.modeId === 'OPEN_CLOUD_MENU'){
					this._showMenu(this.cloudMenu);
					return;
				}
				if(ud.modeId === 'SELECT_CLOUD'){
					this.anomaliesActive = false;
					document.dispatchEvent(new CustomEvent('vr-cloud-select', { detail: { cloud: ud.cloudId } }));
					this._hideAllMenus();
					return;
				}
				if(ud.modeId === 'TOGGLE_ANOMALIES'){
					this._toggleAnomalies();
					this._hideAllMenus();
					return;
				}
				if(ud.modeId === 'PLACE_WALK_START'){
					this._startWalkStartMode();
					return;
				}

				// Submenú de medidas
				if(ud.modeId === 'OPEN_MEASURE'){
					this._showMenu(this.measureMenu);
					return;
				}
				if(ud.modeId === 'OPEN_ATTRIBUTE'){
					this._showMenu(this.attributeMenu);
					if(this._attributeRefresh) this._attributeRefresh();
					this._buildAttrControls(this._getActiveAttribute());
					return;
				}
				if(ud.modeId === 'OPEN_CLIP'){
					this._showMenu(this.clipMenu);
					return;
				}
				if(ud.modeId === 'OPEN_CLIP_TASK'){
					this._showMenu(this.clipTaskMenu);
					if(this._clipTaskRefresh) this._clipTaskRefresh();
					return;
				}
				if(ud.modeId === 'CLIP_DELIMIT'){
					this._showMenu(this.clipShapeMenu);
					return;
				}
				if(ud.modeId === 'CLIP_POLYGON'){
					this._startPolygonMode();
					return;
				}
				if(ud.modeId === 'CLIP_SHAPE_BOX'){
					this.clipShape = 'box';
					this._startClipMode();
					return;
				}
				if(ud.modeId === 'CLIP_SHAPE_CYLINDER'){
					this.clipShape = 'cylinder';
					this._startClipMode();
					return;
				}
				if(ud.modeId === 'CLIP_SHAPE_SPHERE'){
					this.clipShape = 'sphere';
					this._startClipMode();
					return;
				}
				if(ud.modeId === 'BACK_TO_CLIP_MENU'){
					this._showMenu(this.clipMenu);
					return;
				}
				if(ud.modeId === 'CLIP_DELETE'){
					this._deleteAllClipBoxes();
					return;
				}
				if(ud.modeId === 'MEASURE_DISTANCE'){
					this._startMeasureMode('distance');
					return;
				}
				if(ud.modeId === 'MEASURE_HEIGHT'){
					this._startMeasureMode('height');
					return;
				}
				if(ud.modeId === 'MEASURE_INFO_POINT'){
					this._startInfoPointMode();
					return;
				}
				if(ud.modeId === 'MEASURE_DELETE_ALL'){
					this._deleteAllMeasurements();
					return;
				}

				// Edición de clasificación
				if(ud.modeId === 'OPEN_EDIT_CLASS'){
					this._showMenu(this.reclassModeMenu);
					return;
				}
				if(ud.modeId === 'RECLASSIFY_MODE_POINT'){
					this.reclassMode = 'point';
					this._openEditClassMenuForSelection();
					return;
				}
				if(ud.modeId === 'RECLASSIFY_MODE_SPRAY'){
					this.reclassMode = 'spray';
					this._openEditClassMenuForSelection();
					return;
				}
				if(ud.modeId === 'OPEN_CLASS_FOR_CLIP'){
					if(this.clipBoxes.length === 0 && this._polygonClips.length === 0){
						console.log('[EditClass] no hay zonas de recorte: coloca una zona primero (Delimitar Zonas o Dibujar Polígono).');
						return;
					}
					this.editClassSegmentMode = true;
					this._openEditClassMenuForSelection();
					return;
				}
				if(ud.modeId === 'EDIT_CLASS_SET_TARGET'){
					// Paso 1: elegir clase de ORIGEN. 'Cualquiera' = sin filtro; 'default' = clases no nombradas.
					if(!this.editClassOrigin){
						if(ud.anyOrigin){
							this.editClassOrigin = { any: true, name: 'cualquiera' };
						}else if(ud.realDefault){
							this.editClassOrigin = { realDefault: true, name: 'default' };
						}else{
							this.editClassOrigin = { code: ud.classCode, name: ud.className };
						}
						this._refreshEditClassStep();
						return;
					}
					// Paso 2: elegir DESTINO y aplicar. 'Cualquiera'/'default' no pueden ser destino → ignorar.
					if(ud.anyOrigin || ud.realDefault) return;
					if(this.editClassSegmentMode){
						this._applyEditClassToClipBoxes(ud.classCode, ud.className);
					}else{
						this._setEditClassTarget(ud.classCode, ud.className);
					}
					return;
				}
				// Handle de slider → iniciar drag
				if(ud.role === 'handle'){
					const slider = ud.parentSlider;
					const normal = new THREE.Vector3();
					this.activeMenu.getWorldDirection(normal);
					const origin = new THREE.Vector3();
					hovered.getWorldPosition(origin);
					this._dragging = {
						slider,
						plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin),
					};
					return;
				}

				// Botones +/−
				if(ud.role === '+' || ud.role === '-'){
					const sUd = ud.parentSlider.userData;
					const delta = ud.role === '+' ? sUd.step : -sUd.step;
					const newVal = Math.max(sUd.min, Math.min(sUd.max, sUd.currentValue + delta));
					sUd.setValue(newVal);
					return;
				}

				// Toggle
				if(ud.kind === 'toggle'){
					ud.toggle();
					return;
				}

				// Botón de color de clase (cicla la paleta)
				if(ud.kind === 'classcolor'){
					ud.onClick();
					return;
				}

				// Radio button (selección de fondo, etc.)
				if(ud.kind === 'radio'){
					ud.setValue(ud.radioValue);
					return;
				}
			}

			// Click fuera de cualquier widget → cerrar menú
			this._hideAllMenus();
			return;
		}

		if(this.clipMode){
			if(this._clipHovered){
				this._beginAxisDrag(this._clipHovered, controller);
			}else if(this._clipPlaceArmed){
				this._placeClipBox(controller);
				this._clipPlaceArmed = false;   // una sola figura por selección de menú (evita colocar de más)
			}
			return;
		}

		if(this.infoPointMode){
			this._placeInfoPoint(controller);
			return;
		}

		if(this.walkStartMode){
			this._placeWalkStart(controller);
			return;
		}

		if(this.editClassMode){
			if(this.reclassMode === 'spray'){
				this.editClassSprayActive = true;
				this._sprayReclassifyAtController(controller); // pasada inmediata (también para taps)
			}else{
				this._applyEditClassAtController(controller);
			}
			return;
		}

		if(this.polygonMode){
			this._addPolygonPoint(controller);
			return;
		}

		if(this.pointsMode){
			this._placeVRPoint(controller);
			return;
		}

		this.toggleMenu();
	}

	onTriggerEnd(controller){
		// Terminar arrastre de eje de recorte si estaba activo
		if(this._clipDragging){
			this._clipDragging = null;
			return;
		}

		// Terminar drag si estaba activo
		if(this._dragging){
			this._dragging = null;
			return;
		}

		// Terminar el spray de reclasificación si estaba activo (no cambiar de modo de navegación)
		if(this.editClassSprayActive){
			this.editClassSprayActive = false;
			return;
		}

		this.triggered.delete(controller);

		if(this.triggered.size === 0){
			this.setMode(this.mode_fly);
		}else if(this.triggered.size === 1){
			this.setMode(this.mode_translate);
		}else if(this.triggered.size === 2){
			this.setMode(this.mode_rotScale);
		}
	}

	_toggleAnomalies(){
		this.anomaliesActive = !this.anomaliesActive;
		document.dispatchEvent(new CustomEvent('vr-anomalies-toggle', { detail: { active: this.anomaliesActive } }));
	}

	onSqueezeStart(controller){
		if(this.anomaliesActive){
			this.anomaliesActive = false;
			document.dispatchEvent(new CustomEvent('vr-anomalies-toggle', { detail: { active: false } }));
			return;
		}

		if(this.polygonMode){
			this._finishPolygon();
			return;
		}

		if(this.clipMode){
			this._finishClipMode();
			return;
		}

		if(this.pointsMode){
			this._finishMeasurement();
			return;
		}

		if(this.infoPointMode){
			this.infoPointMode = false;
			this._clearInfoPreview();
			return;
		}

		if(this.walkStartMode){
			this.walkStartMode = false;
			this._clearInfoPreview();
			return;
		}

		if(this.editClassMode){
			this._finishEditClassSession();
			return;
		}

		this.triggered.add(controller);
		if(this.triggered.size === 1){
			this.setMode(this.mode_translate);
		}else if(this.triggered.size === 2){
			this.setMode(this.mode_rotScale);
		}
	}

	onSqueezeEnd(controller){
		this.triggered.delete(controller);
		if(this.triggered.size === 0){
			this.setMode(this.mode_fly);
		}else if(this.triggered.size === 1){
			this.setMode(this.mode_translate);
		}
	}

	onStart(){

		let position = this.viewer.scene.view.position.clone();
		let direction = this.viewer.scene.view.direction;
		direction.multiplyScalar(-1);

		let target = position.clone().add(direction);
		target.z = position.z;

		let scale = this.viewer.getMoveSpeed();

		this.node.position.copy(position);
		this.node.lookAt(target);
		this.node.scale.set(scale, scale, scale);
		this.node.updateMatrix();
		this.node.updateMatrixWorld();
	}

	onEnd(){
		
	}


	setScene(scene){
		this.scene = scene;
	}

	getCamera(){
		let reference = this.viewer.scene.getActiveCamera();
		let camera = new THREE.PerspectiveCamera();

		// let scale = this.node.scale.x;
		let scale = this.viewer.getMoveSpeed();
		//camera.near = 0.01 / scale;
		camera.near = 0.1;
		camera.far = 1000;
		// camera.near = reference.near / scale;
		// camera.far = reference.far / scale;
		camera.up.set(0, 0, 1);
		camera.lookAt(new THREE.Vector3(0, -1, 0));
		camera.updateMatrix();
		camera.updateMatrixWorld();

		camera.position.copy(this.node.position);
		camera.rotation.copy(this.node.rotation);
		camera.scale.set(scale, scale, scale);
		camera.updateMatrix();
		camera.updateMatrixWorld();
		camera.matrixAutoUpdate = false;
		camera.parent = camera;

		return camera;
	}

	// Rayo del puntero en espacio escena/mundo. En VR se deriva de la pose del mando
	// (+ toScene); en escritorio, del ratón sobre la cámara activa (ya en mundo).
	_pointerWorldRay(controller){
		if(this._isDesktop()){
			const cam = this.viewer.scene.getActiveCamera();
			this._pickRaycaster.setFromCamera(this._desktopPointerNDC, cam);
			return {
				origin: this._pickRaycaster.ray.origin.clone(),
				dir: this._pickRaycaster.ray.direction.clone().normalize(),
			};
		}
		const originVR = new THREE.Vector3();
		const quat = new THREE.Quaternion();
		controller.getWorldPosition(originVR);
		controller.getWorldQuaternion(quat);
		const dirVR = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
		const origin = this.toScene(originVR);
		const dir = this.toScene(originVR.clone().add(dirVR)).sub(origin).normalize();
		return { origin, dir };
	}

	_raycastPointClouds(controller){
		const { origin: originWorld, dir: dirWorld } = this._pointerWorldRay(controller);

		const ray = new THREE.Ray(originWorld, dirWorld);
		const invMat = new THREE.Matrix4();
		const lo = new THREE.Vector3();
		const ld = new THREE.Vector3();
		const bestLocal = new THREE.Vector3();
		let bestNode = null;
		let bestT = Infinity;

		for(const pc of this.viewer.scene.pointclouds){
			const nodes = pc.nodesOnRay(pc.visibleNodes, ray);
			for(const node of nodes){
				if(!node.sceneNode) continue;
				const posAttr = node.sceneNode.geometry && node.sceneNode.geometry.attributes && node.sceneNode.geometry.attributes.position;
				if(!posAttr) continue;

				// Rayo al espacio local del nodo: evita transformar cada punto al mundo (1 inversa
				// por nodo en vez de 1 producto matriz·vector por punto), así el escaneo completo rinde.
				invMat.copy(node.sceneNode.matrixWorld).invert();
				lo.copy(ray.origin).applyMatrix4(invMat);
				ld.copy(ray.origin).add(ray.direction).applyMatrix4(invMat).sub(lo).normalize();

				for(let i = 0; i < posAttr.count; i++){
					const px = posAttr.getX(i), py = posAttr.getY(i), pz = posAttr.getZ(i);
					const dx = px - lo.x, dy = py - lo.y, dz = pz - lo.z;
					const t = dx * ld.x + dy * ld.y + dz * ld.z;
					if(t <= 0) continue;
					const perp2 = dx*dx + dy*dy + dz*dz - t*t;
					if(perp2 > VR_PICK_TAN2 * t*t) continue;   // fuera del cono angular → descartar
					if(t < bestT){ bestT = t; bestLocal.set(px, py, pz); bestNode = node; }   // dentro → el más cercano gana
				}
			}
		}

		const bestPoint = bestNode ? bestLocal.applyMatrix4(bestNode.sceneNode.matrixWorld) : null;
		return bestPoint;
	}

	_startMeasureMode(type){
		if(this.pointsMode) this._finishMeasurement();
		this.measureType = type;
		document.dispatchEvent(new CustomEvent('vr-mode-select', { detail: { mode: 3 } }));
		this._hideAllMenus();
	}

	_ensureMeasurement(){
		if(this.activeMeasurement) return;
		console.log('[VRPTS] creando Potree.Measure...');
		const m = new Potree.Measure();
		if(this.measureType === 'height'){
			m.name = 'VR Altura';
			m.showDistances = false;
			m.showHeight = true;
		}else{
			m.name = 'VR Puntos';
			m.showDistances = true;
			m.showHeight = false;
		}
		m.showArea = false;
		m.showCoordinates = false;
		m.showAngles = false;
		m.showCircle = false;
		m.showAzimuth = false;
		m.showEdges = true;
		m.closed = false;
		m.maxMarkers = (this.measureType === 'height') ? 2 : Infinity;
		const pc = this.viewer.scene.pointclouds[0];
		if(pc && pc.scale.x > 1.5) m.scaleDivisor = pc.scale.x;
		this.viewer.scene.addMeasurement(m);
		this.activeMeasurement = m;
	}

	_placeVRPoint(controller){
		const pos = this._raycastPointClouds(controller);
		if(!pos) return;

		this._ensureMeasurement();

		// El último marker actual es el preview: lo fijamos en la posición confirmada
		// y añadimos un nuevo marker que pasa a ser el nuevo preview.
		const m = this.activeMeasurement;
		if(m.points.length > 0){
			m.setPosition(m.points.length - 1, pos);
		}
		m.addMarker(pos);
	}

	_updatePreviewMarker(controller){
		if(!this.pointsMode || !controller) return;
		const pos = this._raycastPointClouds(controller);
		if(!pos) return;

		this._ensureMeasurement();
		const m = this.activeMeasurement;
		if(m.points.length === 0){
			m.addMarker(pos);
		}else{
			m.setPosition(m.points.length - 1, pos);
		}
	}

	_finishMeasurement(){
		if(this.activeMeasurement && this.activeMeasurement.points.length > 0){
			// Eliminar el último marker (preview no confirmado)
			this.activeMeasurement.removeMarker(this.activeMeasurement.points.length - 1);
			// Si solo quedaban puntos preview y no se confirmó ninguno, eliminar la medición entera
			if(this.activeMeasurement.points.length === 0){
				this.viewer.scene.removeMeasurement(this.activeMeasurement);
			}
		}
		this.activeMeasurement = null;
		this.pointsMode = false;
	}

	_shrinkPointSizeForPlacement(){
		this._savedPointSizes = [];
		for(const pc of this.viewer.scene.pointclouds){
			if(!pc || !pc.material) continue;
			this._savedPointSizes.push({ material: pc.material, size: pc.material.size });
			pc.material.size = 0; // el shader lo limita a minSize (~2 px)
		}
		this._placementShrinkActive = true;
	}

	_restorePointSize(){
		if(this._savedPointSizes){
			for(const e of this._savedPointSizes){
				if(e.material) e.material.size = e.size;
			}
		}
		this._savedPointSizes = null;
		this._placementShrinkActive = false;
	}

	// ===== Recorte por polígono dibujado a mano =====

	_startPolygonMode(){
		if(this.pointsMode) this._finishMeasurement();
		this.polygonMode = true;
		this._polygonPoints = [];

		// Cámara de proyección "según tu vista": ortográfica situada en la pose de la cabeza/cámara
		// y orientada en la dirección de la mirada → el recorte se extruye como prisma recto en esa
		// dirección. En escritorio la cámara activa ya está en espacio escena (sin toScene); en VR
		// se parte de la cámara XR y se convierte con this.toScene (igual que _raycastPointClouds).
		let scenePos, sceneDir;
		if(this._isDesktop()){
			const cam0 = this.viewer.scene.getActiveCamera();
			scenePos = cam0.getWorldPosition(new THREE.Vector3());
			sceneDir = cam0.getWorldDirection(new THREE.Vector3()).normalize();
		}else{
			const fakeCam = new THREE.PerspectiveCamera();
			const camVR = this.viewer.renderer.xr.getCamera(fakeCam);
			const vrPos = camVR.getWorldPosition(new THREE.Vector3());
			const vrDir = camVR.getWorldDirection(new THREE.Vector3());
			scenePos = this.toScene(vrPos);
			sceneDir = this.toScene(vrPos.clone().add(vrDir)).sub(scenePos).normalize();
		}

		// Tamaño del frustum ortográfico ~ diagonal de la nube (irrelevante para el test, que
		// es invariante a escala, pero mantiene NDC en un rango razonable).
		const pc = this.viewer.scene.pointclouds[0];
		let half = 50;
		if(pc && pc.boundingBox){
			const d = pc.boundingBox.getSize(new THREE.Vector3()).length();
			if(d > 0) half = d * 0.5;
		}

		const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, Math.max(half * 10, 1000));
		// up = Z de Potree; si la mirada es casi vertical, usar un up alternativo para evitar
		// una orientación degenerada en lookAt.
		const up = (Math.abs(sceneDir.z) > 0.99) ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
		cam.up.copy(up);
		cam.position.copy(scenePos);
		cam.lookAt(scenePos.clone().add(sceneDir));
		cam.updateMatrix();
		cam.updateMatrixWorld();
		cam.updateProjectionMatrix();
		this._polygonCamera = cam;

		// Previsualización del contorno (Potree.Measure cerrado, se renderiza en VR)
		const m = new Potree.Measure();
		m.name = 'VR Polígono';
		m.showDistances = false;
		m.showHeight = false;
		m.showArea = false;
		m.showCoordinates = false;
		m.showAngles = false;
		m.showCircle = false;
		m.showAzimuth = false;
		m.showEdges = true;
		m.closed = true;
		m.maxMarkers = Infinity;
		this.viewer.scene.addMeasurement(m);
		this._polygonPreview = m;

		this._hideAllMenus();
		this._setLaserLength(true);
	}

	_addPolygonPoint(controller){
		if(this._polygonPoints.length >= 8) return; // límite del shader (max_clip_polygons)
		const pos = this._raycastPointClouds(controller);
		if(!pos) return;

		this._polygonPoints.push(pos.clone());

		// El último marker es el preview; lo fijamos y añadimos uno nuevo (patrón de _placeVRPoint)
		const m = this._polygonPreview;
		if(m){
			if(m.points.length > 0) m.setPosition(m.points.length - 1, pos);
			m.addMarker(pos);
		}
	}

	_updatePolygonPreview(controller){
		if(!this.polygonMode || !controller) return;
		const pos = this._raycastPointClouds(controller);
		if(!pos) return;
		const m = this._polygonPreview;
		if(!m) return;
		if(m.points.length === 0){
			m.addMarker(pos);
		}else{
			m.setPosition(m.points.length - 1, pos);
		}
	}

	_finishPolygon(){
		if(this._polygonPoints.length >= 3 && this._polygonCamera){
			const v = new Potree.PolygonClipVolume(this._polygonCamera);
			// proj·view: proyecta los puntos pintados (mundo) a NDC, igual que hará el shader
			// con proj·view·world·p_local. Guardamos los markers en NDC.
			const vp = v.projMatrix.clone().multiply(v.viewMatrix);
			const n = Math.min(this._polygonPoints.length, 8);
			for(let i = 0; i < n; i++){
				const ndc = this._polygonPoints[i].clone().applyMatrix4(vp);
				const marker = new THREE.Mesh();
				marker.position.set(ndc.x, ndc.y, 0);
				v.markers.push(marker);
			}
			v.initialized = true;
			this.viewer.scene.addPolygonClipVolume(v);
			this._polygonClips.push(v);

			// Asegurar que el recorte sea visible si aún no se eligió una tarea de recorte.
			if(this.viewer.getClipTask() === Potree.ClipTask.NONE){
				this.viewer.setClipTask(Potree.ClipTask.SHOW_INSIDE);
			}
		}

		if(this._polygonPreview){
			this.viewer.scene.removeMeasurement(this._polygonPreview);
			this._polygonPreview = null;
		}
		this._polygonPoints = [];
		this._polygonCamera = null;
		this.polygonMode = false;
		this._setLaserLength(false);
		this._showMenu(this.clipMenu);
	}

	// ===== Punto de información =====

	_raycastPointCloudsWithAttrs(controller){
		const { origin: originWorld, dir: dirWorld } = this._pointerWorldRay(controller);

		const ray = new THREE.Ray(originWorld, dirWorld);
		const invMat = new THREE.Matrix4();
		const lo = new THREE.Vector3();
		const ld = new THREE.Vector3();
		const bestLocal = new THREE.Vector3();
		let bestNode = null;
		let bestIdx = -1;
		let bestPc = null;
		let bestT = Infinity;

		for(const pc of this.viewer.scene.pointclouds){
			const nodes = pc.nodesOnRay(pc.visibleNodes, ray);
			for(const node of nodes){
				if(!node.sceneNode) continue;
				const posAttr = node.sceneNode.geometry && node.sceneNode.geometry.attributes && node.sceneNode.geometry.attributes.position;
				if(!posAttr) continue;

				// Rayo al espacio local del nodo (ver _raycastPointClouds): cono angular + más cercano.
				invMat.copy(node.sceneNode.matrixWorld).invert();
				lo.copy(ray.origin).applyMatrix4(invMat);
				ld.copy(ray.origin).add(ray.direction).applyMatrix4(invMat).sub(lo).normalize();

				for(let i = 0; i < posAttr.count; i++){
					const px = posAttr.getX(i), py = posAttr.getY(i), pz = posAttr.getZ(i);
					const dx = px - lo.x, dy = py - lo.y, dz = pz - lo.z;
					const t = dx * ld.x + dy * ld.y + dz * ld.z;
					if(t <= 0) continue;
					const perp2 = dx*dx + dy*dy + dz*dz - t*t;
					if(perp2 > VR_PICK_TAN2 * t*t) continue;   // fuera del cono angular → descartar
					if(t < bestT){ bestT = t; bestLocal.set(px, py, pz); bestNode = node; bestIdx = i; bestPc = pc; }
				}
			}
		}

		if(!bestNode) return null;
		const bestPoint = bestLocal.applyMatrix4(bestNode.sceneNode.matrixWorld);

		const attrs = {};
		const geomAttrs = bestNode.sceneNode.geometry.attributes;
		for(const attrName in geomAttrs){
			if(attrName === 'position' || attrName === 'indices') continue;
			const attr = geomAttrs[attrName];
			const vals = [];
			for(let j = 0; j < attr.itemSize; j++) vals.push(attr.array[bestIdx * attr.itemSize + j]);
			attrs[attrName] = vals;
		}

		return { position: bestPoint, attrs, node: bestNode, pIndex: bestIdx, pointcloud: bestPc };
	}

	_startInfoPointMode(){
		if(this.pointsMode) this._finishMeasurement();
		this.infoPointMode = true;
		this._hideAllMenus();
	}

	_startWalkStartMode(){
		if(this.pointsMode) this._finishMeasurement();
		if(this.infoPointMode){ this.infoPointMode = false; this._clearInfoPreview(); }
		this.walkStartMode = true;
		this._hideAllMenus();
	}

	// Coloca el inicio del modo paseo: raycast al punto bajo el mando, convierte sus coordenadas al
	// espacio del modo paseo (la nube se escala x10) y pide a la página recargar el paseo ahí.
	_placeWalkStart(controller){
		const result = this._raycastPointCloudsWithAttrs(controller);
		if(!result || !result.position) return; // sin impacto: seguir en el modo para reintentar

		const pc = result.pointcloud || this.viewer.scene.pointclouds[0];
		if(!pc) return;

		// Punto en coords de mundo (a la escala actual) → coords locales de la nube (invariantes a la
		// escala). Luego se recompone la posición de mundo como si la nube estuviese a escala 10 (la
		// del modo paseo), respetando la transformación del padre.
		pc.updateMatrixWorld(true);
		const local = pc.worldToLocal(result.position.clone());
		const parentWorld = pc.parent ? pc.parent.matrixWorld : new THREE.Matrix4();
		const localMat10 = new THREE.Matrix4().compose(pc.position, pc.quaternion, new THREE.Vector3(10, 10, 10));
		const world10 = new THREE.Matrix4().multiplyMatrices(parentWorld, localMat10);
		const walkWorld = local.applyMatrix4(world10);
		walkWorld.z += 20.7; // altura de los ojos (mismo offset que las nubes existentes, en escala x10)

		const start = [walkWorld.x, walkWorld.y, walkWorld.z];

		this.walkStartMode = false;
		this._clearInfoPreview();

		// La página guarda el inicio por nube y recarga el modo paseo (ver listener 'vr-set-walk-start').
		document.dispatchEvent(new CustomEvent('vr-set-walk-start', { detail: { start } }));
	}

	_clearInfoPreview(){
		if(this.infoPreviewMeasure){
			this.viewer.scene.removeMeasurement(this.infoPreviewMeasure);
			this.infoPreviewMeasure = null;
		}
	}

	_clearInfoPoint(){
		if(this.infoPointMeasure){
			this.viewer.scene.removeMeasurement(this.infoPointMeasure);
			this.infoPointMeasure = null;
		}
		this._clearInfoPreview();
	}

	_buildInfoMeasure(color){
		const m = new Potree.Measure();
		m.showDistances = false;
		m.showHeight = false;
		m.showArea = false;
		m.showCoordinates = false;
		m.showAngles = false;
		m.showCircle = false;
		m.showAzimuth = false;
		m.showEdges = false;
		m.closed = false;
		m.maxMarkers = 1;
		m.color = new THREE.Color(color);
		const pc = this.viewer.scene.pointclouds[0];
		if(pc && pc.scale.x > 1.5) m.scaleDivisor = pc.scale.x;
		return m;
	}

	_createInfoLabel(position, attrs, worldScale){
		const LABELS = {
			'intensity':         'Intensity',
			'return number':     'Return No.',
			'number of returns': 'N. Returns',
			'classification':    'Classif.',
			'scan angle rank':   'Scan Angle',
			'user data':         'User Data',
			'source id':         'Src. ID',
			'gps-time':          'GPS-Time',
			'gps time':          'GPS-Time',
			'color':             'RGB',
			'rgba':              'RGB',
			'rgb':               'RGB',
		};

		const lines = ['PUNTO DE INFO'];
		lines.push(`X: ${position.x.toFixed(2)}`);
		lines.push(`Y: ${position.y.toFixed(2)}`);
		lines.push(`Z: ${position.z.toFixed(2)}`);

		for(const [key, vals] of Object.entries(attrs)){
			const label = LABELS[key];
			if(!label) continue;
			let valStr;
			if(key === 'color' || key === 'rgba' || key === 'rgb'){
				const r = Math.round(vals[0] <= 1 ? vals[0] * 255 : vals[0]);
				const g = Math.round(vals[1] <= 1 ? vals[1] * 255 : vals[1]);
				const b = Math.round(vals[2] <= 1 ? vals[2] * 255 : vals[2]);
				valStr = `${r}, ${g}, ${b}`;
			} else {
				const v = vals[0];
				valStr = Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : '—';
			}
			lines.push(`${label}: ${valStr}`);
		}

		const fontSize = 28;
		const lineH = Math.round(fontSize * 1.4);
		const paddingX = 16;
		const paddingY = 12;

		const measureCanvas = document.createElement('canvas');
		const measureCtx = measureCanvas.getContext('2d');
		measureCtx.font = `bold ${fontSize}px monospace`;
		let maxWidth = 0;
		for(const line of lines){
			const w = measureCtx.measureText(line).width;
			if(w > maxWidth) maxWidth = w;
		}

		const canvas = document.createElement('canvas');
		canvas.width = Math.ceil(maxWidth + paddingX * 2);
		canvas.height = lineH * lines.length + paddingY * 2;
		const ctx = canvas.getContext('2d');

		ctx.fillStyle = 'rgba(13,27,46,0.92)';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.strokeStyle = '#4fc3f7';
		ctx.lineWidth = 3;
		ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

		ctx.textAlign = 'left';
		lines.forEach((line, i) => {
			ctx.fillStyle = i === 0 ? '#4fc3f7' : '#ffffff';
			ctx.font = (i === 0 ? `bold ${fontSize}px monospace` : `${fontSize}px monospace`);
			ctx.fillText(line, paddingX, paddingY + fontSize + i * lineH);
		});

		const texture = new THREE.CanvasTexture(canvas);
		texture.minFilter = THREE.LinearFilter;
		texture.magFilter = THREE.LinearFilter;
		const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false });
		const sprite = new THREE.Sprite(mat);
		// Base pequeño multiplicado por la escala del usuario VR para que la etiqueta
		// se vea con un tamaño similar en paseo (scale~10) y aéreo (scale ~100-300).
		const k = 0.005 * (Math.max(1, worldScale || 1));
		sprite.scale.set(canvas.width * k, canvas.height * k, 1);
		return sprite;
	}

	_placeInfoPoint(controller){
		const result = this._raycastPointCloudsWithAttrs(controller);
		if(!result) return;

		const { position, attrs } = result;
		this._clearInfoPoint();

		const m = this._buildInfoMeasure(0x00e5ff);
		this.viewer.scene.addMeasurement(m);
		m.addMarker(position);

		const worldScale = (this.node && this.node.scale) ? this.node.scale.x : 1;
		const label = this._createInfoLabel(position, attrs, worldScale);
		label.position.copy(position);
		// Justo encima de la esfera: medio alto del rótulo + un pequeño margen.
		label.position.z += label.scale.y * 0.55;
		m.add(label);

		this.infoPointMeasure = m;
		this.infoPointMode = false;
		this._clearInfoPreview();
	}

	_deleteAllMeasurements(){
		// Salir de modos activos para evitar reentrancia
		if(this.pointsMode){
			this.pointsMode = false;
			this.activeMeasurement = null;
		}
		if(this.infoPointMode){
			this.infoPointMode = false;
		}
		if(this.editClassMode){
			this.editClassMode = false;
			this._clearEditClassPreview();
		}
		// Limpiar referencias propias antes de borrar (removeMeasurement dispara eventos)
		this.infoPointMeasure = null;
		this.infoPreviewMeasure = null;

		// Copia del array porque removeMeasurement lo muta
		const all = this.viewer.scene.measurements.slice();
		for(const m of all){
			this.viewer.scene.removeMeasurement(m);
		}
	}

	// ===== Edición de classification por punto =====

	_classNameForCode(code){
		const scheme = this.viewer.classifications;
		const entry = scheme && scheme[code];
		return (entry && entry.name) ? entry.name : ('clase ' + code);
	}

	// Actualiza el título/pista de la rejilla según el paso (eligiendo ORIGEN o DESTINO).
	_refreshEditClassStep(){
		if(this.editClassTitle){
			this.editClassTitle.setText(this.editClassOrigin ? 'DESTINO' : 'ORIGEN');
		}
		if(this.editClassHint){
			if(this.editClassOrigin){
				const o = this.editClassOrigin;
				const label = o.any ? 'cualquiera' : (o.realDefault ? 'default' : `${o.code} ${o.name}`);
				this.editClassHint.setText(`Origen: ${label} → elige destino`);
			}else{
				this.editClassHint.setText('Elige la clase de ORIGEN (la que se cambiará)');
			}
		}
	}

	// Abre la rejilla de clases empezando una selección nueva (paso ORIGEN).
	_openEditClassMenuForSelection(){
		this.editClassOrigin = null;
		this._refreshEditClassStep();
		this._showMenu(this.editClassMenu);
	}

	_setEditClassTarget(code, name){
		// Salir de modos incompatibles
		if(this.pointsMode) this._finishMeasurement();
		if(this.infoPointMode){ this.infoPointMode = false; this._clearInfoPreview(); }
		this.editClassTarget = { code, name: name || this._classNameForCode(code) };
		this.editClassMode = true;
		// Marca el punto del log donde empieza esta sesión: al salir (squeeze) exportamos solo
		// los cambios hechos desde aquí.
		this._reclassSessionStart = this.editClassLog.length;
		this._clearEditClassPreview();
		this._hideAllMenus();
	}

	// Termina la sesión de edición punto/spray: guarda automáticamente el .json con los puntos
	// cambiados en esta sesión y limpia el estado de edición.
	_finishEditClassSession(){
		if(!this.editClassMode) return;
		const entries = this.editClassLog.slice(this._reclassSessionStart || 0);
		this._saveReclassJSON(this.reclassMode, this.editClassOrigin, this.editClassTarget, entries);
		this.editClassMode = false;
		this._clearEditClassPreview();
	}

	_clearEditClassPreview(){
		if(this.editClassPreviewMeasure){
			this.viewer.scene.removeMeasurement(this.editClassPreviewMeasure);
			this.editClassPreviewMeasure = null;
		}
		if(this.editClassBrushPreview){
			this.viewer.scene.scene.remove(this.editClassBrushPreview);
			if(this.editClassBrushPreview.geometry) this.editClassBrushPreview.geometry.dispose();
			if(this.editClassBrushPreview.material) this.editClassBrushPreview.material.dispose();
			this.editClassBrushPreview = null;
		}
		this.editClassSprayActive = false;
	}

	// Convierte una posición en mundo a coordenadas del pointcloud y devuelve la clave del Map
	_overrideKey(pointcloud, worldPos){
		const inv = pointcloud.matrixWorld.clone().invert();
		const local = worldPos.clone().applyMatrix4(inv);
		return `${local.x.toFixed(6)}|${local.y.toFixed(6)}|${local.z.toFixed(6)}`;
	}

	_applyEditClassAtController(controller){
		if(!this.editClassTarget) return;
		const result = this._raycastPointCloudsWithAttrs(controller);
		if(!result) return;

		const { position, node, pIndex, pointcloud } = result;
		if(!node || !node.sceneNode) return;
		const classAttr = node.sceneNode.geometry && node.sceneNode.geometry.attributes.classification;
		if(!classAttr){
			console.log('[EditClass] el nodo no tiene atributo classification');
			return;
		}

		const pc = pointcloud || this.viewer.scene.pointclouds[0];
		const newCode = this.editClassTarget.code;
		const newName = this.editClassTarget.name;

		if(this._changePointClassification(node, pIndex, position, pc, newCode, newName)){
			classAttr.needsUpdate = true;

			// Feedback háptico breve si el dispositivo lo soporta
			try {
				const ga = controller && controller.inputSource && controller.inputSource.gamepad;
				const act = ga && ga.hapticActuators && ga.hapticActuators[0];
				if(act && act.pulse) act.pulse(0.5, 60);
			} catch(_) {}
		}
	}

	// Pasada de spray: raycast al centro apuntado y pinta la esfera del pincel a su alrededor.
	_sprayReclassifyAtController(controller){
		const result = this._raycastPointCloudsWithAttrs(controller);
		if(result && result.position) this._sprayPaintAtCenter(result.position, controller);
	}

	// Reclasifica todos los puntos dentro de la esfera de radio editClassSprayRadius centrada
	// en `center` (mundo). Reutiliza el patrón de recorrido de nodos de _applyEditClassToClipBoxes.
	_sprayPaintAtCenter(center, controller){
		if(!this.editClassTarget || !center) return;
		const newCode = this.editClassTarget.code;
		const newName = this.editClassTarget.name;
		const r = this.editClassSprayRadius;
		const r2 = r * r;

		const brushBox = new THREE.Box3(
			center.clone().subScalar(r),
			center.clone().addScalar(r)
		);

		const tmp = new THREE.Vector3();
		const nodeBox = new THREE.Box3();
		let changed = 0;

		for(const pc of this.viewer.scene.pointclouds){
			for(const node of pc.visibleNodes){
				const sn = node.sceneNode;
				if(!sn || !sn.geometry) continue;
				const posAttr = sn.geometry.attributes.position;
				const classAttr = sn.geometry.attributes.classification;
				if(!posAttr || !classAttr) continue;

				// Pre-filtrado: descartar nodos cuya AABB no toca el pincel
				if(sn.geometry.boundingBox){
					nodeBox.copy(sn.geometry.boundingBox).applyMatrix4(sn.matrixWorld);
					if(!nodeBox.intersectsBox(brushBox)) continue;
				}

				const mat = sn.matrixWorld;
				let nodeChanged = false;
				for(let i = 0; i < posAttr.count; i++){
					tmp.fromBufferAttribute(posAttr, i).applyMatrix4(mat);
					const dx = tmp.x - center.x, dy = tmp.y - center.y, dz = tmp.z - center.z;
					if(dx*dx + dy*dy + dz*dz > r2) continue;
					if(this._changePointClassification(node, i, tmp.clone(), pc, newCode, newName)){
						changed++;
						nodeChanged = true;
					}
				}
				if(nodeChanged) classAttr.needsUpdate = true; // un marcado por nodo
			}
		}

		// Feedback háptico leve y throttled si se pintó algo
		if(changed > 0 && controller){
			const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
			if(now - this._editClassSprayHapticTs > 150){
				this._editClassSprayHapticTs = now;
				try {
					const ga = controller.inputSource && controller.inputSource.gamepad;
					const act = ga && ga.hapticActuators && ga.hapticActuators[0];
					if(act && act.pulse) act.pulse(0.3, 30);
				} catch(_) {}
			}
		}
	}

	// Crea/actualiza la esfera translúcida que previsualiza el alcance del pincel de spray.
	_updateSprayBrushPreview(center){
		if(!this.editClassBrushPreview){
			const mat = new THREE.MeshBasicMaterial({
				color: 0xff00ff, transparent: true, opacity: 0.18,
				depthWrite: false, side: THREE.DoubleSide,
			});
			const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat);
			mesh.renderOrder = 10;
			this.editClassBrushPreview = mesh;
			this.viewer.scene.scene.add(mesh);
		}
		this.editClassBrushPreview.visible = true;
		this.editClassBrushPreview.position.copy(center);
		const r = this.editClassSprayRadius;
		this.editClassBrushPreview.scale.set(r, r, r);
	}

	// Aplica el cambio de clase a UN punto ya identificado. Devuelve true si se modificó.
	// El llamador debe marcar classAttr.needsUpdate (una sola vez por nodo).
	_changePointClassification(node, pIndex, worldPos, pc, newCode, newName){
		const classAttr = node.sceneNode && node.sceneNode.geometry && node.sceneNode.geometry.attributes.classification;
		if(!classAttr) return false;
		const oldCode = classAttr.array[pIndex];
		// Filtro por clase de ORIGEN: 'Cualquiera' (any) no filtra; 'default' (realDefault) coge solo
		// los códigos SIN entrada propia en el esquema (los que se pintan con el DEFAULT real de Potree).
		const o = this.editClassOrigin;
		if(o){
			if(o.realDefault){
				if(this.viewer.classifications[oldCode]) return false; // código nombrado → no es 'default' real
			}else if(!o.any && oldCode !== o.code){
				return false;
			}
		}
		if(oldCode === newCode) return false;
		classAttr.array[pIndex] = newCode;
		this.editClassOverrides.set(this._overrideKey(pc, worldPos), newCode);
		this.editClassLog.push({
			x: worldPos.x, y: worldPos.y, z: worldPos.z,
			fromCode: oldCode, toCode: newCode,
			fromName: this._classNameForCode(oldCode), toName: newName,
			ts: new Date().toISOString(),
		});
		return true;
	}

	// Test punto-en-zona shape-aware (mundo).
	// AABB con escala anisótropa → semi-ejes (sx/2, sy/2, sz/2). Normalizando a esos
	// semi-ejes obtenemos (dx,dy,dz) y el test depende de la forma.
	_pointInClipEntry(worldPos, entry){
		const c = entry.volume.position, s = entry.volume.scale;
		const dx = (worldPos.x - c.x) / (s.x * 0.5);
		const dy = (worldPos.y - c.y) / (s.y * 0.5);
		const dz = (worldPos.z - c.z) / (s.z * 0.5);
		const shape = entry.shape || 'box';
		if(shape === 'sphere')   return dx*dx + dy*dy + dz*dz <= 1;          // elipsoide
		if(shape === 'cylinder') return Math.abs(dz) <= 1 && (dx*dx + dy*dy) <= 1; // sección elíptica XY, altura Z
		return Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && Math.abs(dz) <= 1;  // box
	}

	// Aplica una clase a TODOS los puntos dentro de las zonas de recorte activas
	// (unión por forma exacta). Itera nodos cargados/visibles, escribe en el buffer de
	// classification y registra cada cambio en editClassLog (lo verás luego en el TXT).
	_applyEditClassToClipBoxes(newCode, newName){
		if(!this.clipBoxes.length && !this._polygonClips.length){
			this.editClassSegmentMode = false;
			this._showMenu(this.clipMenu);
			return;
		}

		// Marca dónde empiezan los cambios de esta operación de zona para exportarlos al terminar.
		const logStart = this.editClassLog.length;

		// AABBs en mundo (Box3) para cajas/esferas/cilindros (axis-aligned, sin rotación)
		const aabbs = this.clipBoxes.map(({volume}) => {
			const h = volume.scale.clone().multiplyScalar(0.5);
			return new THREE.Box3(
				volume.position.clone().sub(h),
				volume.position.clone().add(h)
			);
		});

		// Unión de las AABBs para descartar nodos que no tocan ninguna caja. Solo se usa como
		// pre-filtrado cuando NO hay polígonos: el prisma de un polígono es infinito y no tiene
		// AABB acotada, así que con polígonos hay que examinar todos los nodos.
		let unionAabb = null;
		for(const b of aabbs){ unionAabb = unionAabb ? unionAabb.union(b) : b.clone(); }
		const usePreFilter = this.clipBoxes.length > 0 && this._polygonClips.length === 0;

		// proj·view de cada polígono (precomputado): proyecta puntos de mundo a NDC.
		const polyVPs = this._polygonClips.map(v => v.projMatrix.clone().multiply(v.viewMatrix));

		const tmp = new THREE.Vector3();
		const nodeBox = new THREE.Box3();
		let changed = 0;

		for(const pc of this.viewer.scene.pointclouds){
			for(const node of pc.visibleNodes){
				const sn = node.sceneNode;
				if(!sn || !sn.geometry) continue;
				const posAttr = sn.geometry.attributes.position;
				const classAttr = sn.geometry.attributes.classification;
				if(!posAttr || !classAttr) continue;

				// Pre-filtrado por AABB de cajas (solo cuando no hay polígonos)
				if(usePreFilter && unionAabb && sn.geometry.boundingBox){
					nodeBox.copy(sn.geometry.boundingBox).applyMatrix4(sn.matrixWorld);
					if(!nodeBox.intersectsBox(unionAabb)) continue;
				}

				const mat = sn.matrixWorld;
				let nodeChanged = false;
				for(let i = 0; i < posAttr.count; i++){
					tmp.fromBufferAttribute(posAttr, i).applyMatrix4(mat);
					// Dentro de cualquier zona: caja/esfera/cilindro (forma exacta) o polígono
					let inside = false;
					for(const entry of this.clipBoxes){
						if(this._pointInClipEntry(tmp, entry)){ inside = true; break; }
					}
					if(!inside){
						for(let k = 0; k < polyVPs.length; k++){
							if(this._pointInPolygonClip(tmp, this._polygonClips[k], polyVPs[k])){ inside = true; break; }
						}
					}
					if(!inside) continue;
					if(this._changePointClassification(node, i, tmp.clone(), pc, newCode, newName)){
						changed++;
						nodeChanged = true;
					}
				}
				if(nodeChanged) classAttr.needsUpdate = true; // un marcado por nodo
			}
		}

		console.log(`[EditClass] segmento: ${changed} puntos reclasificados a '${newName}'`);
		this._saveReclassJSON('zona', this.editClassOrigin, { name: newName },
			this.editClassLog.slice(logStart));
		this.editClassSegmentMode = false;
		this._showMenu(this.clipMenu);
	}

	// Test punto-en-polígono (prisma según la cámara del PolygonClipVolume), replicando el
	// algoritmo de ray-casting 2D en NDC del shader (pointInClipPolygon). `vp` = proj·view.
	_pointInPolygonClip(worldPos, volume, vp){
		const ndc = worldPos.clone().applyMatrix4(vp);
		const m = volume.markers;
		let inside = false;
		for(let i = 0, j = m.length - 1; i < m.length; j = i++){
			const xi = m[i].position.x, yi = m[i].position.y;
			const xj = m[j].position.x, yj = m[j].position.y;
			if(((yi > ndc.y) !== (yj > ndc.y)) &&
			   (ndc.x < (xj - xi) * (ndc.y - yi) / (yj - yi) + xi)){
				inside = !inside;
			}
		}
		return inside;
	}

	// Guarda automáticamente un .json con los puntos reclasificados en una operación.
	// `modalidad`: 'point' | 'spray' | 'zona'. `origen`: editClassOrigin ({any}|{realDefault}|{code,name}).
	// `destino`: objeto con .name. `entries`: subconjunto de editClassLog de esta operación.
	// Solo cuando el origen es 'Cualquiera' (any) se incluye la clase original de cada punto.
	_saveReclassJSON(modalidad, origen, destino, entries){
		if(!entries || entries.length === 0){
			console.log('[EditClass] no hay cambios para guardar');
			return;
		}
		const includeOriginal = !!(origen && origen.any === true);
		const data = {
			modalidad: modalidad,
			claseOrigen: (origen && origen.name) ? origen.name : 'desconocido',
			claseDestino: (destino && destino.name) ? destino.name : '',
			fecha: new Date().toISOString(),
			numPuntos: entries.length,
			puntos: entries.map(e => {
				const p = {
					x: Number(e.x.toFixed(4)),
					y: Number(e.y.toFixed(4)),
					z: Number(e.z.toFixed(4)),
				};
				if(includeOriginal) p.claseOriginal = e.fromName;
				return p;
			}),
		};
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
		const url = window.URL.createObjectURL(blob);
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const a = document.createElement('a');
		a.href = url;
		a.download = `reclasificacion_${modalidad}_${stamp}.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(() => window.URL.revokeObjectURL(url), 1000);
		console.log(`[EditClass] guardado ${a.download} (${entries.length} puntos)`);
	}

	// Reaplica los overrides al buffer de un nodo recién cargado/visible
	_reapplyEditClassOverridesToNode(node, pc){
		if(this.editClassOverrides.size === 0) return;
		if(!node || !node.sceneNode) return;
		const geom = node.sceneNode.geometry;
		const posAttr = geom && geom.attributes && geom.attributes.position;
		const classAttr = geom && geom.attributes && geom.attributes.classification;
		if(!posAttr || !classAttr) return;

		// Matriz que lleva coords locales del nodo a coords del pointcloud
		const inv = pc.matrixWorld.clone().invert();
		const m = new THREE.Matrix4().multiplyMatrices(inv, node.sceneNode.matrixWorld);
		const tmp = new THREE.Vector3();

		let modified = false;
		for(let i = 0; i < posAttr.count; i++){
			tmp.fromBufferAttribute(posAttr, i).applyMatrix4(m);
			const key = `${tmp.x.toFixed(6)}|${tmp.y.toFixed(6)}|${tmp.z.toFixed(6)}`;
			const newCode = this.editClassOverrides.get(key);
			if(newCode !== undefined && classAttr.array[i] !== newCode){
				classAttr.array[i] = newCode;
				modified = true;
			}
		}
		if(modified) classAttr.needsUpdate = true;
	}

	// ===== Recortado de zonas (clipping con cubo) =====

	_startClipMode(){
		if(this.pointsMode) this._finishMeasurement();
		this.clipMode = true;
		this._clipPlaceArmed = true;  // un disparo colocará una sola figura; luego se desarma
		this._clipDragging = null;
		this._clipHovered = null;
		this._ensureClipHandleGroup();
		if(this._clipHandleGroup) this._clipHandleGroup.visible = true;
		this._hideAllMenus();
		this._setLaserLength(true);
	}

	_finishClipMode(){
		this._clipPlaceArmed = false;
		this._clipDragging = null;
		if(this._clipHovered && this._clipHovered.material){
			this._clipHovered.material.color.setHex(this._clipHovered.userData.baseColor);
		}
		this._clipHovered = null;
		if(this._clipHandleGroup) this._clipHandleGroup.visible = false;
		this.clipMode = false;
		this._setLaserLength(false);
	}

	_ensureClipHandleGroup(){
		if(this._clipHandleGroup) return;
		const g = new THREE.Group();
		g.name = 'vr-clip-handles';
		const vt = this.viewer.volumeTool;
		if(vt && vt.scene) vt.scene.add(g);
		this._clipHandleGroup = g;
	}

	_clipPointerRay(controller){
		if(!controller && !this._isDesktop()) return null;
		const { origin, dir } = this._pointerWorldRay(controller);
		return { origin, direction: dir };
	}

	_placeClipBox(controller){
		const ray = this._clipPointerRay(controller);
		if(!ray) return;

		// Posición: intersección con la nube; si no hay, a unos pocos lados delante del mando
		let pos = this._raycastPointClouds(controller);
		let edge;
		if(pos){
			// Tamaño = ~3/4 de la distancia del usuario (mando) al punto seleccionado, de
			// modo que apuntar lejos crea figuras grandes y apuntar cerca, pequeñas.
			const dist = pos.distanceTo(ray.origin);
			edge = Math.max(dist * 0.75, 1e-3);
			// Desplazar la caja hacia el observador a lo largo del rayo para que no quede
			// medio enterrada: el punto apuntado queda en su tercio trasero, pero dentro de
			// la caja, de modo que sigue encerrando el volumen de puntos de la superficie.
			pos.addScaledVector(ray.direction, -edge * 0.3);
		}else{
			// Sin punto de nube apuntado: tamaño por defecto ~18% de la diagonal de la nube
			// (en unidades de mundo) y colocación a unos lados delante del mando.
			const pc = this.viewer.scene.pointclouds[0];
			let diag = 10;
			if(pc && pc.boundingBox){
				diag = pc.boundingBox.getSize(new THREE.Vector3()).length();
			}
			edge = Math.max(diag * 0.18, 1e-3);
			pos = ray.origin.clone().addScaledVector(ray.direction, edge * 5);
		}

		const shape = this.clipShape || 'box';
		const v = new Potree.BoxVolume();
		v.clip = true;
		v.name = 'VR Clip ' + (this.clipBoxes.length + 1) + ' (' + shape + ')';
		v.userData.clipShape = shape; // leído por viewer.js para separar el tipo de test en el shader
		v.position.copy(pos);
		v.scale.set(edge, edge, edge);

		// Para forma 'box' usamos el frame que ya trae BoxVolume.
		// Para 'sphere'/'cylinder' ocultamos ese frame y añadimos un wireframe propio
		// (LineSegments unit-bound ±0.5) como hijo, así hereda position/scale del BoxVolume.
		let visualMesh = null;
		if(shape === 'box'){
			if(v.frame && v.frame.material) v.frame.material.color.setHex(0xffff00);
		}else{
			if(v.frame) v.frame.visible = false;
			const lineMat = new THREE.LineBasicMaterial({ color: 0xffff00, depthWrite: false });
			let wireGeom;
			if(shape === 'sphere'){
				wireGeom = new THREE.WireframeGeometry(new THREE.SphereGeometry(0.5, 16, 16));
			}else{ // cylinder
				wireGeom = new THREE.WireframeGeometry(new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 1, true));
			}
			visualMesh = new THREE.LineSegments(wireGeom, lineMat);
			if(shape === 'cylinder'){
				// Eje del cilindro alineado a Z (eje arriba en Potree)
				visualMesh.rotation.x = Math.PI / 2;
			}
			v.add(visualMesh);
		}

		this.viewer.scene.addVolume(v);

		const entry = { shape, volume: v, visualMesh, handles: [] };
		this._createAxisHandles(entry);
		this.clipBoxes.push(entry);
		this._updateClipHandles();
	}

	_createAxisHandles(entry){
		this._ensureClipHandleGroup();
		const colors = [0xff3333, 0x33ff33, 0x3333ff]; // X, Y, Z
		const geo = new THREE.SphereGeometry(1, 16, 16);
		for(let axis = 0; axis < 3; axis++){
			for(const sign of [1, -1]){
				const mat = new THREE.MeshBasicMaterial({ color: colors[axis], depthTest: false, depthWrite: false });
				const mesh = new THREE.Mesh(geo, mat);
				mesh.renderOrder = 10;
				mesh.userData = { kind: 'cliphandle', role: 'axis', entry, axisIndex: axis, sign, baseColor: colors[axis] };
				if(this._clipHandleGroup) this._clipHandleGroup.add(mesh);
				entry.handles.push(mesh);
			}
		}
		// Tirador central (naranja) para MOVER el volumen entero; se resalta en blanco al apuntarlo
		const centerMat = new THREE.MeshBasicMaterial({ color: 0xff8000, depthTest: false, depthWrite: false });
		const centerMesh = new THREE.Mesh(geo, centerMat);
		centerMesh.renderOrder = 10;
		centerMesh.userData = { kind: 'cliphandle', role: 'center', entry, baseColor: 0xff8000 };
		if(this._clipHandleGroup) this._clipHandleGroup.add(centerMesh);
		entry.handles.push(centerMesh);
	}

	_updateClipHandles(){
		if(!this.clipBoxes.length) return;
		const axisVec = [
			new THREE.Vector3(1, 0, 0),
			new THREE.Vector3(0, 1, 0),
			new THREE.Vector3(0, 0, 1),
		];
		for(const entry of this.clipBoxes){
			const v = entry.volume;
			const sc = v.scale;
			const r = Math.max(Math.max(sc.x, sc.y, sc.z) * 0.015, 1e-3);
			for(const h of entry.handles){
				if(h.userData.role === 'center'){
					h.position.copy(v.position);
				}else{
					const ai = h.userData.axisIndex;
					const half = (ai === 0 ? sc.x : ai === 1 ? sc.y : sc.z) / 2;
					h.position.copy(v.position).addScaledVector(axisVec[ai], h.userData.sign * half);
				}
				h.scale.set(r, r, r);
			}
		}
	}

	_updateClipHover(pointer){
		const ray = this._clipPointerRay(pointer);
		let best = null;
		if(ray){
			let bestT = Infinity;
			const d = new THREE.Vector3();
			for(const entry of this.clipBoxes){
				for(const h of entry.handles){
					const thresh = h.scale.x * 7.2;   // bola 4× más pequeña, área de apuntado igual que antes
					d.copy(h.position).sub(ray.origin);
					const t = d.dot(ray.direction);
					if(t <= 0) continue;
					const perp2 = d.lengthSq() - t * t;
					if(perp2 <= thresh * thresh && t < bestT){
						bestT = t;
						best = h;
					}
				}
			}
		}
		if(best !== this._clipHovered){
			if(this._clipHovered && this._clipHovered.material){
				this._clipHovered.material.color.setHex(this._clipHovered.userData.baseColor);
			}
			this._clipHovered = best;
			if(best && best.material) best.material.color.setHex(0xffffff);
		}
	}

	_beginAxisDrag(handle, controller){
		if(!handle || !handle.userData) return;
		const entry = handle.userData.entry;
		if(handle.userData.role === 'center'){
			// Drag de mover (agarre por rayo): captura la distancia de la figura a lo largo
			// del rayo y el desfase perpendicular. Así la figura sigue el láser manteniendo
			// la distancia de agarre, tanto en VR (cambian origen+dirección al mover la mano)
			// como en escritorio (solo cambia la dirección al mover el ratón).
			const ctrl = controller || this._getRightController() || this.cPrimary;
			const ray = this._clipPointerRay(ctrl);
			let grabDist = 1;
			let offset = new THREE.Vector3();
			if(ray){
				const toVol = entry.volume.position.clone().sub(ray.origin);
				grabDist = Math.max(toVol.dot(ray.direction), 1e-3); // mantener delante del puntero
				offset = toVol.sub(ray.direction.clone().multiplyScalar(grabDist));
			}
			this._clipDragging = {
				entry, kind: 'center',
				grabDist,
				offset,
			};
		}else{
			this._clipDragging = { entry, kind: 'axis', axisIndex: handle.userData.axisIndex };
		}
	}

	// Elimina todos los cubos delimitadores creados. Reutiliza viewer.scene.removeVolume
	// (la misma función que usa el borrado del Potree de escritorio), que dispara
	// 'volume_removed' → VolumeTool lo quita de su escena y deja de recortar.
	_deleteAllClipBoxes(){
		for(const entry of this.clipBoxes){
			this.viewer.scene.removeVolume(entry.volume);
			for(const h of entry.handles){
				if(this._clipHandleGroup) this._clipHandleGroup.remove(h);
				if(h.material) h.material.dispose();
			}
		}
		this.clipBoxes = [];
		this._clipHovered = null;
		this._clipDragging = null;

		// Borrar también los recortes por polígono
		for(const v of this._polygonClips){
			this.viewer.scene.removePolygonClipVolume(v);
		}
		this._polygonClips = [];
	}

	_updateAxisDrag(pointer){
		const ray = this._clipPointerRay(pointer);
		if(!ray) return;
		const drag = this._clipDragging;
		const v = drag.entry.volume;

		if(drag.kind === 'center'){
			// Mover: recolocar la figura sobre el rayo actual a la distancia de agarre
			// capturada, más el desfase perpendicular (patrón "laser grab"). La figura sigue
			// el puntero en VR y en escritorio.
			v.position.copy(ray.origin)
				.addScaledVector(ray.direction, drag.grabDist)
				.add(drag.offset);
			return;
		}

		// kind === 'axis' (lógica existente): redimensionar simétrico respecto al centro
		const ai = drag.axisIndex;
		const C = v.position;
		const A = (ai === 0) ? new THREE.Vector3(1, 0, 0)
			: (ai === 1) ? new THREE.Vector3(0, 1, 0)
			: new THREE.Vector3(0, 0, 1);

		// Punto más cercano entre el rayo (O,dir) y la recta del eje (C,A); dir y A son unitarios
		const w0 = ray.origin.clone().sub(C);
		const b = ray.direction.dot(A);
		const dd = ray.direction.dot(w0);
		const e = A.dot(w0);
		const denom = 1 - b * b;
		if(Math.abs(denom) < 1e-6) return; // rayo casi paralelo al eje
		const tc = (e - b * dd) / denom;   // distancia con signo a lo largo de A desde el centro
		const newSize = Math.max(2 * Math.abs(tc), 1e-3);
		if(ai === 0) v.scale.x = newSize;
		else if(ai === 1) v.scale.y = newSize;
		else v.scale.z = newSize;
	}

	// HUD 3D de rendimiento para VR: el panel de stats es DOM (lo gestiona la página vía
	// window.perfWindow) y no se ve dentro del casco; aquí se vuelcan sus canvas (FPS/CPU) en un
	// plano anclado a la cabeza. Visibilidad y tamaño los controla el submenú "Rendimiento".
	_createPerfHUD(){
		const canvas = document.createElement('canvas');
		canvas.width = 340;
		canvas.height = 100;
		const ctx = canvas.getContext('2d');

		const texture = new THREE.CanvasTexture(canvas);
		texture.minFilter = THREE.LinearFilter;
		texture.magFilter = THREE.LinearFilter;

		const material = new THREE.MeshBasicMaterial({
			map: texture, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
		});
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34 * canvas.height / canvas.width), material);
		mesh.name = 'vr-perf-hud';
		mesh.renderOrder = 1000;
		mesh.frustumCulled = false;
		this.viewer.sceneVR.add(mesh);

		this.perfHUD = mesh;
		this.perfHUDCanvas = canvas;
		this.perfHUDCtx = ctx;
		this.perfHUDTexture = texture;
		this._perfHudFakeCam = new THREE.PerspectiveCamera();
		this._perfHudBaseWidth = 0;
	}

	_updatePerfHUD(){
		const pw = (typeof window !== 'undefined') ? window.perfWindow : null;
		const presenting = this.viewer.renderer.xr.isPresenting;
		if(!pw || !pw.isVisible || !pw.isVisible() || !presenting || !this.viewer.sceneVR){
			if(this.perfHUD) this.perfHUD.visible = false;
			return;
		}
		const panels = pw.getCanvases ? pw.getCanvases() : [];
		if(panels.length === 0){ if(this.perfHUD) this.perfHUD.visible = false; return; }

		if(!this.perfHUD) this._createPerfHUD();
		this.perfHUD.visible = true;

		// Anclar a la cabeza: delante de la cámara VR, desplazado a la esquina inferior izquierda
		// y orientado como billboard (mismo patrón que _positionMenuInFrontOfCamera).
		const camVR = this.viewer.renderer.xr.getCamera(this._perfHudFakeCam);
		const pos = camVR.getWorldPosition(new THREE.Vector3());
		const quat = camVR.getWorldQuaternion(new THREE.Quaternion());
		const offset = new THREE.Vector3(-0.26, -0.16, -1.0).applyQuaternion(quat);
		this.perfHUD.position.copy(pos).add(offset);
		this.perfHUD.quaternion.copy(quat);

		// Volcar cada canvas (FPS/CPU) en fila sobre el canvas compuesto; se redimensiona el plano
		// según el slider (window.perfWindow.getScale()). Solo recrea geometría cuando cambia algo.
		const canvas = this.perfHUDCanvas, ctx = this.perfHUDCtx;
		const pad = 6, targetH = 88;
		let totalW = pad;
		const draws = [];
		for(const p of panels){ const w = targetH * (p.width / p.height); draws.push({ p, x: totalW, w }); totalW += w + pad; }
		const needW = Math.max(1, Math.ceil(totalW));
		const needH = targetH + 2 * pad;
		const scale = pw.getScale ? pw.getScale() : 1;
		const baseWidth = 0.34 * scale;     // ancho físico del plano (m), escalado por el slider
		if(canvas.width !== needW || canvas.height !== needH || this._perfHudBaseWidth !== baseWidth){
			canvas.width = needW;
			canvas.height = needH;
			this._perfHudBaseWidth = baseWidth;
			this.perfHUD.geometry.dispose();
			this.perfHUD.geometry = new THREE.PlaneGeometry(baseWidth, baseWidth * (needH / needW));
		}
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = 'rgba(13, 27, 46, 0.85)';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		for(const d of draws){ try { ctx.drawImage(d.p, d.x, pad, d.w, targetH); } catch(e) { /* canvas aún sin contenido */ } }
		this.perfHUDTexture.needsUpdate = true;
	}

	update(delta){
		this._updatePerfHUD();   // HUD de rendimiento anclado a la cabeza (solo activo en VR)

		const rightCtrl = this._getRightController();
		const pointer = rightCtrl || this.cPrimary;

		// Drag de slider activo
		if(this._dragging && pointer){
			const origin = new THREE.Vector3();
			const quat = new THREE.Quaternion();
			pointer.getWorldPosition(origin);
			pointer.getWorldQuaternion(quat);
			const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
			this._menuRaycaster.set(origin, dir);

			const target = new THREE.Vector3();
			if(this._menuRaycaster.ray.intersectPlane(this._dragging.plane, target)){
				const slider = this._dragging.slider;
				const sUd = slider.userData;
				const localX = slider.worldToLocal(target.clone()).x;
				const t = Math.max(0, Math.min(1, (localX + 0.2) / 0.4));
				const raw = sUd.min + t * (sUd.max - sUd.min);
				const stepped = Math.round(raw / sUd.step) * sUd.step;
				const clamped = Math.max(sUd.min, Math.min(sUd.max, stepped));
				sUd.setValue(clamped);
			}
		}

		// Hover raycasting mientras un menú está abierto
		if(this.activeMenu && this.activeMenu.visible){
			const interactives = this.activeMenu.userData.interactives ?? [];
			if(interactives.length > 0 && pointer){
				const origin = new THREE.Vector3();
				const quat = new THREE.Quaternion();
				pointer.getWorldPosition(origin);
				pointer.getWorldQuaternion(quat);
				const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
				this._menuRaycaster.set(origin, dir);
				const hits = this._menuRaycaster.intersectObjects(interactives);
				this._applyMenuHover(hits, interactives);
			}
		}

		this.mode.update(this, delta);

		this._updateActiveModes(delta, pointer);
	}

	// Trabajo por-frame de los modos de colocación (previews, spray, overrides de clasificación,
	// tiradores de recorte). Compartido entre el bucle VR (update) y el de escritorio
	// (desktopUpdate); todo el raycasting pasa por _pointerWorldRay, que es desktop-aware.
	_updateActiveModes(delta, pointer){
		// Reducir el tamaño de punto al mínimo mientras se colocan medidas, puntos de
		// información o se edita clasificación, para apuntar con más precisión.
		const placing = this.pointsMode || this.infoPointMode || this.editClassMode || this.polygonMode || this.walkStartMode;
		if(placing && !this._placementShrinkActive){
			this._shrinkPointSizeForPlacement();
		}else if(!placing && this._placementShrinkActive){
			this._restorePointSize();
		}

		// Preview del modo Puntos
		if(this.pointsMode && !(this.activeMenu && this.activeMenu.visible)){
			this._updatePreviewMarker(pointer);
		}

		// Preview del modo Dibujar Polígono (arista en vivo desde el último punto)
		if(this.polygonMode && !(this.activeMenu && this.activeMenu.visible)){
			this._updatePolygonPreview(pointer);
		}

		// Preview del modo Punto de Info / Colocar inicio del Paseo (reutiliza la esfera fantasma)
		if((this.infoPointMode || this.walkStartMode) && !(this.activeMenu && this.activeMenu.visible)){
			const pos = this._raycastPointClouds(pointer);
			if(pos){
				if(!this.infoPreviewMeasure){
					const m = this._buildInfoMeasure(0xffeb3b);
					this.viewer.scene.addMeasurement(m);
					m.addMarker(pos);
					this.infoPreviewMeasure = m;
				} else {
					this.infoPreviewMeasure.setPosition(0, pos);
				}
			}
		}

		// Preview del modo Editar Clasificación
		if(this.editClassMode && !(this.activeMenu && this.activeMenu.visible)){
			const pos = this._raycastPointClouds(pointer);
			if(pos){
				if(!this.editClassPreviewMeasure){
					const m = this._buildInfoMeasure(0xff00ff);
					this.viewer.scene.addMeasurement(m);
					m.addMarker(pos);
					this.editClassPreviewMeasure = m;
				} else {
					this.editClassPreviewMeasure.setPosition(0, pos);
				}

				// Modo spray: esfera del pincel + pintado continuo mientras se mantiene el gatillo
				if(this.reclassMode === 'spray'){
					this._updateSprayBrushPreview(pos);
					if(this.editClassSprayActive){
						this._sprayPaintAtCenter(pos, pointer);
					}
				}else if(this.editClassBrushPreview){
					this.editClassBrushPreview.visible = false;
				}
			}
		}

		// Reaplicar overrides de classification a nodos recién cargados
		if(this.editClassOverrides.size > 0){
			for(const pc of this.viewer.scene.pointclouds){
				const visible = pc.visibleNodes || [];
				for(const node of visible){
					if(!node || !node.sceneNode) continue;
					if(this._editClassProcessedNodes.has(node.sceneNode)) continue;
					this._reapplyEditClassOverridesToNode(node, pc);
					this._editClassProcessedNodes.add(node.sceneNode);
				}
			}
		}

		// Recortado de zonas: reposicionar tiradores, hover y arrastre de ejes
		if(this.clipMode){
			this._updateClipHandles();
			if(this._clipDragging){
				this._updateAxisDrag(pointer);
			}else if(!(this.activeMenu && this.activeMenu.visible)){
				this._updateClipHover(pointer);
			}
		}
	}

	// Tick por-frame en escritorio: corre el trabajo de modos con el rayo del ratón cuando hay un
	// modo de colocación activo (o quedan overrides por reaplicar). No toca navegación ni menú.
	desktopUpdate(delta){
		if(!this._isDesktop()) return;
		if(!this._anyPlacementModeActive() && this.editClassOverrides.size === 0) return;
		this._updateActiveModes(delta, this.cPrimary);
	}
};