import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import * as Tone from 'tone';

// --- Global State ---
const state = {
    decay: 0.95,
    zoom: 0.985,
    rotation: 0.01,
    hueShift: 0.005
};

// --- WebGL & Buffer Setup ---
// 2048x2048 high-fidelity buffers to maintain sharpness deep into the recursion tunnel
const RT_SIZE = 2048; 
const rtParams = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, 
    type: THREE.HalfFloatType
};

// Two buffers are all we need: One to capture the physical 3D room, one to hold the processed math
let rtCapture = new THREE.WebGLRenderTarget(RT_SIZE, RT_SIZE, rtParams);
let rtFeedback = new THREE.WebGLRenderTarget(RT_SIZE, RT_SIZE, rtParams);

// --- The Feedback Math (Analog Degradation Simulator) ---
const compositeMaterial = new THREE.ShaderMaterial({
    uniforms: {
        tDiffuse: { value: null },
        decay: { value: state.decay },
        zoom: { value: state.zoom },
        angle: { value: state.rotation },
        hueShift: { value: state.hueShift }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float decay;
        uniform float zoom;
        uniform float angle;
        uniform float hueShift;
        varying vec2 vUv;

        vec3 rgb2hsv(vec3 c) {
            vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
            vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
            vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
            float d = q.x - min(q.w, q.y);
            float e = 1.0e-10;
            return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
        }

        vec3 hsv2rgb(vec3 c) {
            vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
            vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
            return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
        }

        void main() {
            vec2 center = vec2(0.5, 0.5);
            vec2 uv = (vUv - center) * zoom;
            
            float s = sin(angle);
            float c = cos(angle);
            mat2 rot = mat2(c, -s, s, c);
            uv = rot * uv;
            uv += center;

            vec4 texColor = texture2D(tDiffuse, uv);

            // Execute Hue Shift on the trailing pixels
            if (hueShift > 0.001 && texColor.a > 0.01) {
                vec3 hsv = rgb2hsv(texColor.rgb);
                hsv.x = fract(hsv.x + hueShift);
                texColor.rgb = hsv2rgb(hsv);
            }
            
            // Fade both color and alpha so the physical AR room stays visible
            gl_FragColor = vec4(texColor.rgb * decay, texColor.a * decay);
        }
    `,
    transparent: true,
    depthWrite: false
});

// --- UI Parameter Bindings ---
['Decay', 'Zoom', 'Rot', 'Hue'].forEach(param => {
    const el = document.getElementById(`param${param}`);
    const valEl = document.getElementById(`val${param}`);
    if(el) {
        el.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            valEl.innerText = val.toFixed(3);
            if (param === 'Decay') state.decay = val;
            if (param === 'Zoom') state.zoom = val;
            if (param === 'Rot') state.rotation = val;
            if (param === 'Hue') state.hueShift = val;
            
            // Scope fix: Access the correct material uniform
            compositeMaterial.uniforms.decay.value = state.decay;
            compositeMaterial.uniforms.zoom.value = state.zoom;
            compositeMaterial.uniforms.angle.value = state.rotation;
            compositeMaterial.uniforms.hueShift.value = state.hueShift;
        });
    }
});

function updateZoomUI() {
    const el = document.getElementById('paramZoom');
    const valEl = document.getElementById('valZoom');
    if (el && valEl) {
        el.value = state.zoom;
        valEl.innerText = state.zoom.toFixed(3);
    }
}

// --- Audio Initialization ---
let synth, loop;
let pulseScale = 1.0;
let baseScale = new THREE.Vector3(1, 1, 1);

const initBtn = document.getElementById('initAudioBtn');
if (initBtn) {
    initBtn.addEventListener('click', async (e) => {
        await Tone.start();
        
        synth = new Tone.FMSynth({
            harmonicity: 3,
            modulationIndex: 10,
            oscillator: { type: "sine" },
            envelope: { attack: 0.1, decay: 0.2, sustain: 0.1, release: 1.5 },
            modulation: { type: "square" },
            modulationEnvelope: { attack: 0.1, decay: 0.2, sustain: 1, release: 0.5 }
        }).toDestination();

        const notes = ["C3", "D3", "E3", "G3", "A3"];
        let index = 0;
        
        loop = new Tone.Loop(time => {
            let note = notes[index % notes.length];
            synth.triggerAttackRelease(note, "8n", time);
            index++;
            pulseScale = 1.6; // Audio transient scale bump
        }, "4n").start(0);

        Tone.Transport.start();
        
        e.target.innerText = "System Active - Enter AR";
        e.target.style.background = "#55ff55";
    });
}

// --- Scene Architecture ---
const sceneMain = new THREE.Scene();
const xrRig = new THREE.Group();
sceneMain.add(xrRig);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
xrRig.add(camera); 

// The Capture Camera mimics your physical eye to grab the 3D room
const captureCamera = new THREE.PerspectiveCamera(90, 1.0, 0.01, 100);
sceneMain.add(captureCamera); 

// Processing Quad
const sceneComposite = new THREE.Scene();
const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compositeMaterial);
sceneComposite.add(quad);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(ARButton.createButton(renderer));

// --- Environment Sphere (The Projection Canvas) ---
// An inverted sphere surrounding the player. It acts as the physical screen we project the tunnel onto.
const envGeo = new THREE.SphereGeometry(30, 64, 64);
const envMat = new THREE.MeshBasicMaterial({ 
    map: rtFeedback.texture, 
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.NormalBlending 
});
const envSphere = new THREE.Mesh(envGeo, envMat);
xrRig.add(envSphere);

// --- The Seed Geometry ---
const geom = new THREE.IcosahedronGeometry(0.3, 0);
const mat = new THREE.MeshBasicMaterial({ color: 0x00ffcc, wireframe: true });
const seedMain = new THREE.Mesh(geom, mat);
seedMain.position.set(0, 1.5, -1.5); 
xrRig.add(seedMain);

// --- 6DOF Controller & Multi-Touch Logic ---
const controller0 = renderer.xr.getController(0);
xrRig.add(controller0);
const controller1 = renderer.xr.getController(1);
xrRig.add(controller1);

let isGrabbing0 = false;
let isGrabbing1 = false;
let initialPinchDistance = 0;
let initialScale = new THREE.Vector3();

controller0.addEventListener('selectstart', () => { isGrabbing0 = true; });
controller0.addEventListener('selectend', () => { isGrabbing0 = false; });
controller1.addEventListener('selectstart', () => { isGrabbing1 = true; });
controller1.addEventListener('selectend', () => { isGrabbing1 = false; });

function handleControllers() {
    const session = renderer.xr.getSession();
    if (!session) return;

    let leftAxes = [0, 0, 0, 0];
    let rightAxes = [0, 0, 0, 0];

    for (const source of session.inputSources) {
        if (!source.gamepad) continue;
        if (source.handedness === 'left') { leftAxes = source.gamepad.axes; }
        if (source.handedness === 'right') { rightAxes = source.gamepad.axes; }
    }

    // Two-Handed Scaling (Pinch & Pull)
    if (isGrabbing0 && isGrabbing1) {
        let p0 = new THREE.Vector3().setFromMatrixPosition(controller0.matrixWorld);
        let p1 = new THREE.Vector3().setFromMatrixPosition(controller1.matrixWorld);
        const currentDistance = p0.distanceTo(p1);

        if (initialPinchDistance === 0) {
            initialPinchDistance = currentDistance;
            initialScale.copy(baseScale);
        } else {
            const ratio = currentDistance / initialPinchDistance;
            baseScale.copy(initialScale).multiplyScalar(ratio);
        }
    } else {
        initialPinchDistance = 0; 
    }

    // Single-Hand Grab Translation & Rotation
    if ((isGrabbing0 || isGrabbing1) && !(isGrabbing0 && isGrabbing1)) {
        const activeController = isGrabbing0 ? controller0 : controller1;
        // Position relative to the XR Rig
        seedMain.position.copy(activeController.position);
        seedMain.quaternion.copy(activeController.quaternion);
    }

    // Left Thumbstick: Translate object X/Z
    if (Math.abs(leftAxes[2] || leftAxes[0] || 0) > 0.05) {
        seedMain.position.x += (leftAxes[2] || leftAxes[0]) * 0.02;
    }
    if (Math.abs(leftAxes[3] || leftAxes[1] || 0) > 0.05) {
        seedMain.position.z += (leftAxes[3] || leftAxes[1]) * 0.02;
    }

    // Right Thumbstick X: Rotate Object Y-Axis
    if (Math.abs(rightAxes[2] || rightAxes[0] || 0) > 0.05) {
        seedMain.rotation.y += (rightAxes[2] || rightAxes[0]) * 0.05;
    }

    // Right Thumbstick Y: Dynamic Feedback Zoom (Distance between copies)
    if (Math.abs(rightAxes[3] || rightAxes[1] || 0) > 0.05) {
        const zoomDelta = (rightAxes[3] || rightAxes[1]) * 0.002;
        state.zoom = THREE.MathUtils.clamp(state.zoom - zoomDelta, 0.5, 1.5);
        compositeMaterial.uniforms.zoom.value = state.zoom;
        updateZoomUI();
    }
}

// --- Render Loop Execution ---
renderer.setAnimationLoop(() => {
    handleControllers();

    // Auto-rotate ONLY if not grabbing
    if (!isGrabbing0 && !isGrabbing1 && Math.abs(state.zoom - 1.0) > 0.001) {
       seedMain.rotation.x += 0.005;
    }

    // Combine manual scale gesture with audio transient pulse
    pulseScale = THREE.MathUtils.lerp(pulseScale, 1.0, 0.1);
    seedMain.scale.copy(baseScale).multiplyScalar(pulseScale);

    // Sync Capture Camera to the VR Headset's physical location
    captureCamera.position.setFromMatrixPosition(camera.matrixWorld);
    captureCamera.quaternion.setFromRotationMatrix(camera.matrixWorld);

    // CRITICAL FIX: Safe Off-Screen Rendering
    // By passing rtCapture to setRenderTarget, Three.js automatically suspends the stereo XR compositor for this draw call
    const currentRT = renderer.getRenderTarget();

    // 1. Capture the entire 3D room (Seed + The EnvSphere projecting the previous frame)
    renderer.setRenderTarget(rtCapture);
    renderer.clear();
    renderer.render(sceneMain, captureCamera);

    // 2. Mathematically warp the captured room (Apply Decay/Zoom/Hue)
    compositeMaterial.uniforms.tDiffuse.value = rtCapture.texture;
    renderer.setRenderTarget(rtFeedback);
    renderer.clear();
    renderer.render(sceneComposite, orthoCamera);

    // 3. Render the stereoscopic view to your VR Headset
    renderer.setRenderTarget(currentRT); 
    renderer.clear();
    renderer.render(sceneMain, camera);
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
