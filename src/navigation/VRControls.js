
import * as THREE from "../../libs/three.js/build/three.module.js";
import {EventDispatcher} from "../EventDispatcher.js";
import { XRControllerModelFactory } from '../../libs/three.js/webxr/XRControllerModelFactory.js';
import {Line2} from "../../libs/three.js/lines/Line2.js";
import {LineGeometry} from "../../libs/three.js/lines/LineGeometry.js";
import {LineMaterial} from "../../libs/three.js/lines/LineMaterial.js";

let fakeCam = new THREE.PerspectiveCamera();

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

		let primary = vrControls.cPrimary;
		let secondary = vrControls.cSecondary;

		let move1 = computeMove(vrControls, primary);
		let move2 = computeMove(vrControls, secondary);


		if(!move1){
			move1 = new THREE.Vector3();
		}

		if(!move2){
			move2 = new THREE.Vector3();
		}

		let move = move1.clone().add(move2);

		move.multiplyScalar(-delta * this.moveFactor);
		vrControls.node.position.add(move);
		

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

		this.menu = null;
		this.menuButtons = [];
		this._menuRaycaster = new THREE.Raycaster();

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

		document.addEventListener('vr-mode-select', (e) => {
			if(e.detail.mode !== 3 && this.pointsMode) this._finishMeasurement();
			this.pointsMode = (e.detail.mode === 3);
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
		if(this.menu) return;
		this._createVRMenu();
	}

	_createVRMenu(){
		const group = new THREE.Group();
		group.name = 'vr-mode-menu';
		group.visible = false;

		// Fondo del panel
		const bgMat = new THREE.MeshBasicMaterial({
			color: 0x0d1b2e,
			transparent: true,
			opacity: 0.88,
			side: THREE.DoubleSide,
		});
		const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.52), bgMat);
		group.add(bg);

		// Título
		const title = new Potree.TextSprite('MODO DE VISIÓN');
		title.scale.set(0.07, 0.07, 0.07);
		title.position.set(0, 0.20, 0.002);
		group.add(title);

		// Botones — fila superior
		const btnWalk = this._createMenuButton('Modo Paseo', 2);
		btnWalk.position.set(-0.17, 0.04, 0.002);
		group.add(btnWalk);

		const btnGod = this._createMenuButton('Modo Aéreo', 1);
		btnGod.position.set(0.17, 0.04, 0.002);
		group.add(btnGod);

		// Botón fila inferior — modo poner puntos (sin acción por ahora)
		const btnPoints = this._createMenuButton('Activar Colocar\n medidas', 3);
		btnPoints.position.set(0, -0.13, 0.002);
		group.add(btnPoints);

		this.menuButtons = [btnWalk, btnGod, btnPoints];
		this.viewer.sceneVR.add(group);
		this.menu = group;
		window.vrMenu = group;
	}

	_createMenuButton(label, modeId){
		const canvas = document.createElement('canvas');
		canvas.width = 256;
		canvas.height = 128;
		this._drawButtonCanvas(canvas, label, false);

		const tex = new THREE.CanvasTexture(canvas);
		const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.14), mat);
		mesh.userData = { modeId, label, canvas, tex, hovered: false };
		return mesh;
	}

	_drawButtonCanvas(canvas, label, highlighted){
		const ctx = canvas.getContext('2d');
		ctx.clearRect(0, 0, 256, 128);
		ctx.fillStyle = highlighted ? '#2255bb' : '#162538';
		ctx.fillRect(0, 0, 256, 128);
		ctx.strokeStyle = highlighted ? '#88ccff' : '#3a6090';
		ctx.lineWidth = 5;
		ctx.strokeRect(3, 3, 250, 122);
		ctx.fillStyle = '#ffffff';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';

		const lines = label.split('\n');
		if(lines.length === 1){
			ctx.font = 'bold 34px Arial, sans-serif';
			ctx.fillText(label, 128, 64);
		} else {
			ctx.font = 'bold 26px Arial, sans-serif';
			const lineH = 34;
			const startY = 64 - ((lines.length - 1) * lineH) / 2;
			lines.forEach((line, i) => ctx.fillText(line, 128, startY + i * lineH));
		}
	}


	toggleMenu(){
		if(!this.menu) return;
		this.menu.visible = !this.menu.visible;
		if(this.menu.visible){
			this._positionMenuInFrontOfCamera();
		}
	}

	_positionMenuInFrontOfCamera(){
		const camVR = this.viewer.renderer.xr.getCamera(fakeCam);
		const pos = new THREE.Vector3();
		const dir = new THREE.Vector3();
		camVR.getWorldPosition(pos);
		camVR.getWorldDirection(dir);

		const menuPos = pos.clone().addScaledVector(dir, 1.5);
		menuPos.y -= 0.05;
		this.menu.position.copy(menuPos);
		this.menu.lookAt(pos);
		console.log(`[VRMenu] cam=(${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}) menu=(${menuPos.x.toFixed(2)},${menuPos.y.toFixed(2)},${menuPos.z.toFixed(2)})`);
	}

	_getRightController(){
		for(const c of [this.cPrimary, this.cSecondary]){
			if(c.inputSource && c.inputSource.handedness === 'right') return c;
		}
		return null;
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
		if(this.menu && this.menu.visible){
			const hovered = this.menuButtons.find(btn => btn.userData.hovered);
			if(hovered){
				document.dispatchEvent(new CustomEvent('vr-mode-select', { detail: { mode: hovered.userData.modeId } }));
			}
			this.menu.visible = false;
			return;
		}

		if(this.pointsMode){
			this._placeVRPoint(controller);
			return;
		}

		this.toggleMenu();
	}

	onTriggerEnd(controller){
		this.triggered.delete(controller);

		if(this.triggered.size === 0){
			this.setMode(this.mode_fly);
		}else if(this.triggered.size === 1){
			this.setMode(this.mode_translate);
		}else if(this.triggered.size === 2){
			this.setMode(this.mode_rotScale);
		}
	}

	onSqueezeStart(controller){
		if(this.pointsMode){
			this._finishMeasurement();
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

	_raycastPointClouds(controller){
		const originVR = new THREE.Vector3();
		const quat = new THREE.Quaternion();
		controller.getWorldPosition(originVR);
		controller.getWorldQuaternion(quat);

		const dirVR = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
		const originWorld = this.toScene(originVR);
		const dirWorld = this.toScene(originVR.clone().add(dirVR)).sub(originWorld).normalize();

		console.log('[VRPTS] ray origin=' + originWorld.x.toFixed(0) + ',' + originWorld.y.toFixed(0) + ',' + originWorld.z.toFixed(0) + ' pcs=' + this.viewer.scene.pointclouds.length);

		const ray = new THREE.Ray(originWorld, dirWorld);
		const tmp = new THREE.Vector3();
		let bestPoint = null;
		let bestPerp2 = Infinity;

		for(const pc of this.viewer.scene.pointclouds){
			const nodes = pc.nodesOnRay(pc.visibleNodes, ray);
			console.log('[VRPTS] nodesOnRay=' + nodes.length + ' visibleNodes=' + pc.visibleNodes.length);
			for(const node of nodes){
				if(!node.sceneNode) continue;
				const posAttr = node.sceneNode.geometry && node.sceneNode.geometry.attributes && node.sceneNode.geometry.attributes.position;
				if(!posAttr) continue;
				const mat = node.sceneNode.matrixWorld;
				for(let i = 0; i < posAttr.count; i += 10){
					tmp.fromBufferAttribute(posAttr, i).applyMatrix4(mat);
					const dx = tmp.x - ray.origin.x;
					const dy = tmp.y - ray.origin.y;
					const dz = tmp.z - ray.origin.z;
					const t = dx * ray.direction.x + dy * ray.direction.y + dz * ray.direction.z;
					if(t <= 0) continue;
					const perp2 = dx*dx + dy*dy + dz*dz - t*t;
					if(perp2 < bestPerp2){ bestPerp2 = perp2; bestPoint = tmp.clone(); }
				}
			}
		}

		console.log('[VRPTS] raycast result=' + (bestPoint ? bestPoint.x.toFixed(0)+','+bestPoint.y.toFixed(0) : 'null'));
		return bestPoint;
	}

	_ensureMeasurement(){
		if(this.activeMeasurement) return;
		console.log('[VRPTS] creando Potree.Measure...');
		const m = new Potree.Measure();
		m.name = 'VR Puntos';
		m.showDistances = true;
		m.showArea = false;
		m.showCoordinates = false;
		m.showHeight = false;
		m.showAngles = false;
		m.showCircle = false;
		m.showAzimuth = false;
		m.showEdges = true;
		m.closed = false;
		m.maxMarkers = Infinity;
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

	update(delta){

		// Hover raycasting mientras el menú está abierto
		const rightCtrl = this._getRightController();
		if(this.menu && this.menu.visible && this.menuButtons.length > 0){
			const pointer = rightCtrl || this.cPrimary;
			if(pointer){
				const origin = new THREE.Vector3();
				const quat = new THREE.Quaternion();
				pointer.getWorldPosition(origin);
				pointer.getWorldQuaternion(quat);
				const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
				this._menuRaycaster.set(origin, dir);
				const hits = this._menuRaycaster.intersectObjects(this.menuButtons);

				for(const btn of this.menuButtons){
					const hovered = hits.length > 0 && hits[0].object === btn;
					if(btn.userData.hovered !== hovered){
						btn.userData.hovered = hovered;
						this._drawButtonCanvas(btn.userData.canvas, btn.userData.label, hovered);
						btn.userData.tex.needsUpdate = true;
					}
				}
			}
		}

		this.mode.update(this, delta);

		// Preview del modo Puntos: el último marker sigue al raycast del controlador derecho
		if(this.pointsMode && !(this.menu && this.menu.visible)){
			console.log('[VRPTS] preview tick');
			try {
				this._updatePreviewMarker(rightCtrl || this.cPrimary);
				console.log('[VRPTS] preview ok');
			} catch(e) {
				console.log('[VRPTS] ERROR preview: ' + e.message + '\n' + (e.stack || ''));
			}
		}

	}
};