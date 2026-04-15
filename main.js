import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import * as Tone from 'tone';

// --- Global State ---
const state = {
    decay: 0.95,
    zoom: 0.98,
    rotation: 0.02,
    hueShift: 0.005,
    audioReady: false
};

// --- UI Bindings ---
['Decay', 'Zoom', 'Rot', 'Hue'].forEach(param => {
    const el = document.getElementById(`param${param}`);
    const valEl = document.getElementById(`val${param}`);
    if(el) {
        el.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            valEl.innerText = val;
            if (param === 'Decay') state.decay = val;
            if (param === 'Zoom') state.zoom = val;
            if (param === 'Rot') state.rotation = val;
            if (param === 'Hue') state.hueShift = val;
            
            if (feedbackMaterial) {
                feedbackMaterial.uniforms.decay.value = state.decay;
                feedbackMaterial.uniforms.zoom.value = state.zoom;
                feedbackMaterial.uniforms.angle.value = state.rotation;
                feedbackMaterial.uniforms.hueShift.value = state.hueShift;
            }
        });
    }
});

// --- Audio Engine (Tone.js) ---
let synth, loop;
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
            pulseGeometry();
        }, "4n").start(0);

        Tone.Transport.start();
        
        state.audioReady = true;
        e.target.innerText = "Audio Active - Now Click Enter AR";
        e.target.style.background = "#55ff55";
    });
}

// --- Scene Setup ---
const scene = new THREE.Scene();

// The Master Rig decoupling feedback logic from head tracking
const xrRig = new THREE.Group();
scene.add(xrRig);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
xrRig.add(camera); // VR Headset tracking mounts here

// The Static Capture Camera (90 FOV perfectly maps to a 20x20 plane at 10m depth)
const monoCamera = new THREE.PerspectiveCamera(90, 1.0, 0.01, 100);
monoCamera.position.set(0, 1.2, 0);
monoCamera.lookAt(0, 1.2, -10);
xrRig.add(monoCamera);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(ARButton.createButton(renderer));

// --- High-Fidelity Ping-Pong Buffers ---
const RT_SIZE = 2048; // Forcing maximum clarity
const rtParams = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, 
    type: THREE.HalfFloatType
};
let renderTargetA = new THREE.WebGLRenderTarget(RT_SIZE, RT_SIZE, rtParams);
let renderTargetB = new THREE.WebGLRenderTarget(RT_SIZE, RT_SIZE, rtParams);

// --- Feedback Shader (VISION.md Integration) ---
const feedbackMaterial = new THREE.ShaderMaterial({
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
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float decay;
        uniform float zoom;
        uniform float angle;
        uniform float hueShift;
        varying vec2 vUv;

        // HSV Translation for Rainbow Recursion
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
            
            if (hueShift > 0.001 && texColor.a > 0.05) {
                vec3 hsv = rgb2hsv(texColor.rgb);
                hsv.x = fract(hsv.x + hueShift);
                texColor.rgb = hsv2rgb(hsv);
            }
            
            gl_FragColor = vec4(texColor.rgb * decay, texColor.a * decay);
        }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending
});

// The physical screen anchored in the world generating the infinite tunnel
const feedbackPlaneGeo = new THREE.PlaneGeometry(20, 20);
const feedbackPlane = new THREE.Mesh(feedbackPlaneGeo, feedbackMaterial);
feedbackPlane.position.set(0, 1.2, -10); 
xrRig.add(feedbackPlane);

// --- 3D Sacred Geometry (The Seed) ---
const geom = new THREE.IcosahedronGeometry(0.3, 0);
const mat = new THREE.MeshBasicMaterial({ color: 0x00ffcc, wireframe: true });
const seedMesh = new THREE.Mesh(geom, mat);
seedMesh.position.set(0, 1.2, -1.5); 
xrRig.add(seedMesh);

let pulseScale = 1.0;
function pulseGeometry() {
    pulseScale = 1.8; 
}

// --- Locomotion ---
function handleLocomotion() {
    const session = renderer.xr.getSession();
    if (!session) return;
    for (const source of session.inputSources) {
        if (source.gamepad && source.handedness === 'left') {
            const axes = source.gamepad.axes;
            xrRig.position.x += (axes[2] || axes[0] || 0) * 0.05;
            xrRig.position.z += (axes[3] || axes[1] || 0) * 0.05;
        }
    }
}

// --- Render Loop ---
renderer.setAnimationLoop(() => {
    handleLocomotion();

    // Animate Seed Geometry
    seedMesh.rotation.x += 0.01;
    seedMesh.rotation.y += 0.02;
    pulseScale = THREE.MathUtils.lerp(pulseScale, 1.0, 0.1);
    seedMesh.scale.setScalar(pulseScale);

    const currentRT = renderer.getRenderTarget();
    const isXRActive = renderer.xr.enabled;

    // STEP A: Capture Loop (Must bypass XR interception to prevent double-vision artifacts)
    renderer.xr.enabled = false; 
    renderer.setRenderTarget(renderTargetB);
    renderer.clear();
    feedbackMaterial.uniforms.tDiffuse.value = renderTargetA.texture;
    renderer.render(scene, monoCamera); 

    // STEP B: Headset Presentation Loop
    renderer.xr.enabled = isXRActive; 
    renderer.setRenderTarget(currentRT); 
    renderer.clear();
    feedbackMaterial.uniforms.tDiffuse.value = renderTargetB.texture;
    renderer.render(scene, camera);

    // STEP C: Swap buffers
    let temp = renderTargetA;
    renderTargetA = renderTargetB;
    renderTargetB = temp;
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
