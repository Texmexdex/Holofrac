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
    el.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        valEl.innerText = val;
        if (param === 'Decay') state.decay = val;
        if (param === 'Zoom') state.zoom = val;
        if (param === 'Rot') state.rotation = val;
        
        // Update shader uniforms in real-time
        if (feedbackMaterial) {
            feedbackMaterial.uniforms.decay.value = state.decay;
            feedbackMaterial.uniforms.zoom.value = state.zoom;
            feedbackMaterial.uniforms.angle.value = state.rotation;
        }
    });
});

// --- Audio Engine (Tone.js) ---
let synth, loop;
document.getElementById('initAudioBtn').addEventListener('click', async (e) => {
    await Tone.start();
    
    // Create an atmospheric FM Synth
    synth = new Tone.FMSynth({
        harmonicity: 3,
        modulationIndex: 10,
        detune: 0,
        oscillator: { type: "sine" },
        envelope: { attack: 0.1, decay: 0.2, sustain: 0.1, release: 1.5 },
        modulation: { type: "square" },
        modulationEnvelope: { attack: 0.1, decay: 0.2, sustain: 1, release: 0.5 }
    }).toDestination();

    // Setup a generative loop (pentatonic sequence)
    const notes = ["C3", "D3", "E3", "G3", "A3"];
    let index = 0;
    
    loop = new Tone.Loop(time => {
        let note = notes[index % notes.length];
        synth.triggerAttackRelease(note, "8n", time);
        index++;
        
        // Visual trigger - pulse the geometry scale on beat
        pulseGeometry();
    }, "4n").start(0);

    Tone.Transport.start();
    
    state.audioReady = true;
    e.target.innerText = "Audio Active";
    e.target.style.background = "#55ff55";
});

// --- Scene Setup ---
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);

// alpha: true is mandatory for AR Passthrough
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(ARButton.createButton(renderer));

// --- Ping-Pong Buffers ---
// RGBA format is crucial to preserve the alpha channel for passthrough
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
            gl_Position = vec4(position, 1.0);
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
            
            // 1. Zoom Transform
            vec2 uv = (vUv - center) * zoom;
            
            // 2. Rotation Transform
            float s = sin(angle);
            float c = cos(angle);
            mat2 rot = mat2(c, -s, s, c);
            uv = rot * uv;
            
            // Restore origin
            uv += center;

            // 3. Sample previous frame
            vec4 texColor = texture2D(tDiffuse, uv);
            
            // 4. Apply Decay to color AND alpha (prevents blowing out to solid white)
            gl_FragColor = texColor * decay;
        }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
});

const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quadScene = new THREE.Scene();
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), feedbackMaterial);
quadScene.add(quad);

// --- 3D Sacred Geometry (The Seed) ---
const geom = new THREE.IcosahedronGeometry(0.2, 1);
const mat = new THREE.MeshBasicMaterial({ color: 0x00ffcc, wireframe: true });
const seedMesh = new THREE.Mesh(geom, mat);
seedMesh.position.set(0, 1.2, -1);
scene.add(seedMesh);

let pulseScale = 1.0;
function pulseGeometry() {
    pulseScale = 1.5; // Triggered by Tone.js loop
}

// --- Render Loop (The Ping-Pong Logic) ---
renderer.setAnimationLoop(() => {
    
    // Animate Geometry
    seedMesh.rotation.x += 0.01;
    seedMesh.rotation.y += 0.02;
    pulseScale = THREE.MathUtils.lerp(pulseScale, 1.0, 0.1);
    seedMesh.scale.setScalar(pulseScale);

    // STEP 1: Render the composite (Old Feedback + New Geometry) into Target B
    renderer.setRenderTarget(renderTargetB);
    renderer.clear();
    
    // Draw the warped previous frame
    feedbackMaterial.uniforms.tDiffuse.value = renderTargetA.texture;
    renderer.render(quadScene, orthoCamera);
    
    // Draw the fresh 3D geometry on top
    renderer.clearDepth();
    renderer.render(scene, camera);

    // STEP 2: Render Target B to the actual XR Headset Display
    renderer.setRenderTarget(null);
    renderer.clear();
    
    // We use a simple textured quad to dump Target B to the screen
    feedbackMaterial.uniforms.tDiffuse.value = renderTargetB.texture;
    // Temporarily bypass transformations just for the final screen output
    const oldZoom = feedbackMaterial.uniforms.zoom.value;
    const oldAngle = feedbackMaterial.uniforms.angle.value;
    const oldDecay = feedbackMaterial.uniforms.decay.value;
    
    feedbackMaterial.uniforms.zoom.value = 1.0;
    feedbackMaterial.uniforms.angle.value = 0.0;
    feedbackMaterial.uniforms.decay.value = 1.0;
    
    renderer.render(quadScene, orthoCamera);
    
    // Restore transform variables for the next frame's loop
    feedbackMaterial.uniforms.zoom.value = oldZoom;
    feedbackMaterial.uniforms.angle.value = oldAngle;
    feedbackMaterial.uniforms.decay.value = oldDecay;

    // STEP 3: Swap Buffers (Target B becomes Target A for the next frame)
    let temp = renderTargetA;
    renderTargetA = renderTargetB;
    renderTargetB = temp;
});

// Resize handler
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderTargetA.setSize(window.innerWidth, window.innerHeight);
    renderTargetB.setSize(window.innerWidth, window.innerHeight);
});
