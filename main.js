import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import * as Tone from 'tone';

// --- Global State ---
const state = {
    decay: 0.95,
    zoom: 0.98,
    rotation: 0.02,
    audioReady: false
};

// --- UI Bindings ---
['Decay', 'Zoom', 'Rot'].forEach(param => {
    const el = document.getElementById(`param${param}`);
    const valEl = document.getElementById(`val${param}`);
    if(el) {
        el.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            valEl.innerText = val;
            if (param === 'Decay') state.decay = val;
            if (param === 'Zoom') state.zoom = val;
            if (param === 'Rot') state.rotation = val;
            
            if (feedbackMaterial) {
                feedbackMaterial.uniforms.decay.value = state.decay;
                feedbackMaterial.uniforms.zoom.value = state.zoom;
                feedbackMaterial.uniforms.angle.value = state.rotation;
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
            detune: 0,
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
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
scene.add(camera);

const monoCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(ARButton.createButton(renderer));

// --- Ping-Pong Buffers ---
const rtParams = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, 
    type: THREE.HalfFloatType
};
let renderTargetA = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, rtParams);
let renderTargetB = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, rtParams);

// --- Feedback Shader ---
const feedbackMaterial = new THREE.ShaderMaterial({
    uniforms: {
        tDiffuse: { value: null },
        decay: { value: state.decay },
        zoom: { value: state.zoom },
        angle: { value: state.rotation }
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
        varying vec2 vUv;

        void main() {
            vec2 center = vec2(0.5, 0.5);
            vec2 uv = (vUv - center) * zoom;
            
            float s = sin(angle);
            float c = cos(angle);
            mat2 rot = mat2(c, -s, s, c);
            uv = rot * uv;
            uv += center;

            vec4 texColor = texture2D(tDiffuse, uv);
            gl_FragColor = texColor * decay;
        }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending
});

const feedbackPlaneGeo = new THREE.PlaneGeometry(200, 200);
const feedbackPlane = new THREE.Mesh(feedbackPlaneGeo, feedbackMaterial);
feedbackPlane.position.z = -50; 
camera.add(feedbackPlane);

// --- 3D Sacred Geometry (The Seed) ---
const geom = new THREE.IcosahedronGeometry(0.3, 0);
const mat = new THREE.MeshBasicMaterial({ color: 0x00ffcc, wireframe: true });
const seedMesh = new THREE.Mesh(geom, mat);
seedMesh.position.set(0, 0, -1.5); 
scene.add(seedMesh);

let pulseScale = 1.0;
function pulseGeometry() {
    pulseScale = 1.8; 
}

// --- Render Loop ---
renderer.setAnimationLoop(() => {
    monoCamera.position.copy(camera.position);
    monoCamera.quaternion.copy(camera.quaternion);

    seedMesh.rotation.x += 0.01;
    seedMesh.rotation.y += 0.02;
    pulseScale = THREE.MathUtils.lerp(pulseScale, 1.0, 0.1);
    seedMesh.scale.setScalar(pulseScale);

    const currentRT = renderer.getRenderTarget();

    renderer.setRenderTarget(renderTargetB);
    renderer.clear();
    feedbackMaterial.uniforms.tDiffuse.value = renderTargetA.texture;
    renderer.render(scene, monoCamera); 

    renderer.setRenderTarget(currentRT); 
    renderer.clear();
    feedbackMaterial.uniforms.tDiffuse.value = renderTargetB.texture;
    renderer.render(scene, camera);

    let temp = renderTargetA;
    renderTargetA = renderTargetB;
    renderTargetB = temp;
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    monoCamera.aspect = window.innerWidth / window.innerHeight;
    monoCamera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderTargetA.setSize(window.innerWidth, window.innerHeight);
    renderTargetB.setSize(window.innerWidth, window.innerHeight);
});
