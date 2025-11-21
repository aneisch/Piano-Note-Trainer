const VF = Vex.Flow;

// --- DOM + Renderer ---
const staffEl = document.getElementById("staff");
let renderer = new VF.Renderer(staffEl, VF.Renderer.Backends.SVG);
renderer.resize(400, 200);
let context = renderer.getContext();

// --- Settings ---
const settings = {
  clefMode: localStorage.getItem("clefMode") || "both",
  useAccidentals: localStorage.getItem("useAccidentals") === "true",
  maxRange: parseInt(localStorage.getItem("maxRange") || "1")
};

// --- State ---
let currentClef = "treble";
let currentNote = null;
let lastWrongNote = null;
let wrongFlashTimeout = null;
let stats = { correct: 0, wrong: 0, streak: 0 };
const heldKeys = {}; // midi note -> timestamp
let wakeLock = null; 
// --- Screen Wake Lock Functions ---
/** Request the Wake Lock to keep the screen active. */
async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
        console.log("Wake Lock API not supported.");
        return;
    }
    
    // Release existing lock if any
    if (wakeLock) {
        try {
            await wakeLock.release();
            wakeLock = null;
        } catch (err) {
            console.error('Failed to release previous wake lock:', err);
        }
    }

    try {
        wakeLock = await navigator.wakeLock.request('screen');
        console.log('Screen Wake Lock acquired! 💡');
        // Re-acquire wake lock if it's released by the OS/browser
        wakeLock.addEventListener('release', () => {
            console.log('Screen Wake Lock released by OS/Browser.');
            wakeLock = null; 
            // Attempt to re-acquire the lock immediately
            requestWakeLock();
        });
    } catch (err) {
        console.error('Failed to acquire Screen Wake Lock:', err);
    }
}

/** Release the Wake Lock. */
function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().then(() => {
            wakeLock = null;
            console.log('Screen Wake Lock released manually.');
        }).catch(err => {
             console.error('Failed to release wake lock:', err);
        });
    }
}

// NEW: Host/Client State and WebSocket
let isHost = true; // DEFAULT TO HOST
let ws; // Global WebSocket instance
let roleSwitching = false; // Flag to prevent automatic reconnect during switch

// --- Whitelist per clef ---
const CLEF_NOTES = {
  treble: ["c/4","d/4","e/4","f/4","g/4","a/4","b/4","c/5","d/5","e/5","f/5","g/5","a/5","b/5","c/6"],
  bass:   ["e/2","f/2","g/2","a/2","b/2","c/3","d/3","e/3","f/3","g/3","a/3","b/3","c/4"]
};

// --- Helpers and Game Logic ---
const SEMITONE = {c:0,'c#':1,db:1,d:2,'d#':3,eb:3,e:4,fb:4,'e#':5,f:5,'f#':6,gb:6,g:7,'g#':8,ab:8,a:9,'a#':10,bb:10,b:11,cb:11};
function noteStringToSemitone(noteStr){
  const [note, octaveStr] = noteStr.split("/");
  const semitone = SEMITONE[note.toLowerCase()];
  return semitone + parseInt(octaveStr)*12;
}
function midiToNoteName(num){
  const letters = ["c","c#","d","d#","e","f","f#","g","g#","a","a#","b"];
  const note = letters[num%12];
  const octave = Math.floor(num/12)-1;
  return {note, octave};
}
document.getElementById("clefMode").value = settings.clefMode;
document.getElementById("useAccidentals").checked = settings.useAccidentals;
document.getElementById("maxRange").value = settings.maxRange;
document.getElementById("rangeDisplay").textContent = settings.maxRange;

document.getElementById("clefMode").onchange = e => { 
  if(isHost) {
    settings.clefMode = e.target.value; 
    localStorage.setItem("clefMode", e.target.value); 
    updateSettingsDisplay('host');
    randomNote(); 
  }
};
document.getElementById("useAccidentals").onchange = e => { 
  if(isHost) {
    settings.useAccidentals = e.target.checked; 
    localStorage.setItem("useAccidentals", e.target.checked); 
    updateSettingsDisplay('host');
    randomNote(); 
  }
};
document.getElementById("maxRange").oninput = e => { 
  if(isHost) {
    settings.maxRange = parseInt(e.target.value); 
    document.getElementById("rangeDisplay").textContent = e.target.value; 
    localStorage.setItem("maxRange", settings.maxRange); 
    updateSettingsDisplay('host');
    randomNote(); 
  }
};


/** Toggle Fullscreen mode for the entire document. */
function toggleFullscreen() {
  const fsBtn = document.getElementById("toggleFullscreenButton");
  if (!document.fullscreenElement) {
      // Enter fullscreen
      document.documentElement.requestFullscreen().then(() => {
          fsBtn.textContent = "Exit Fullscreen ⬇️";
      }).catch(err => {
          alert(`Error attempting to enable full-screen mode: ${err.message}`);
      });
  } else if (document.exitFullscreen) {
      // Exit fullscreen
      document.exitFullscreen().then(() => {
          fsBtn.textContent = "Toggle Fullscreen 🖥️";
      }).catch(err => {
           console.error(`Error attempting to exit full-screen mode: ${err.message}`);
      });
  }
}
document.getElementById("toggleFullscreenButton").onclick = toggleFullscreen;
document.addEventListener('fullscreenchange', () => {
  const fsBtn = document.getElementById("toggleFullscreenButton");
  if (fsBtn) {
      fsBtn.textContent = document.fullscreenElement ? "Exit Fullscreen ⬇️" : "Toggle Fullscreen 🖥️";
  }
});
function updateStatsUI(){
  const total = stats.correct + stats.wrong;
  const acc = total? Math.round(stats.correct/total*100) : 0;
  document.getElementById("correct").textContent = stats.correct;
  document.getElementById("wrong").textContent = stats.wrong;
  document.getElementById("streak").textContent = stats.streak;
  document.getElementById("accuracy").textContent = acc+"%";
}
function updateState(newState) {
  currentClef = newState.clef;
  currentNote = newState.note;
  lastWrongNote = newState.lastWrongNote;
  stats = newState.stats;
  
  // NEW: Update settings based on host state
  if (newState.settings) {
    settings.clefMode = newState.settings.clefMode;
    settings.useAccidentals = newState.settings.useAccidentals;
    settings.maxRange = newState.settings.maxRange;
    updateSettingsDisplay('client');
  }

  updateStatsUI();
  renderStaff();
}
function broadcastState(){
    if (!isHost || ws.readyState !== WebSocket.OPEN) return;
    const state = {
        clef: currentClef,
        note: currentNote,
        lastWrongNote: lastWrongNote,
        stats: stats,
        settings: settings // NEW: Include settings in the broadcast
    };
    ws.send(JSON.stringify(state)); 
}
function randomNote(){
  if(!isHost) return;
  currentClef = settings.clefMode==="both"? (Math.random()>0.5?"treble":"bass") : settings.clefMode;
  const center = currentClef==="treble"?4:3;
  let notes = CLEF_NOTES[currentClef].filter(n=>{
    const octave = parseInt(n.slice(-1));
    return octave >= center - settings.maxRange && octave <= center + settings.maxRange;
  });
  if(!settings.useAccidentals) notes = notes.filter(n=>!n.includes("#"));
  const pick = notes[Math.floor(Math.random()*notes.length)];
  currentNote = pick;
  lastWrongNote = null;
  if(wrongFlashTimeout){ clearTimeout(wrongFlashTimeout); wrongFlashTimeout=null; }
  broadcastState();
  renderStaff();
}
function createStaveNote(noteStr, style=null){
  const hasAcc = noteStr.includes("#");
  const n = new VF.StaveNote({ clef: currentClef, keys:[noteStr], duration:"q" });
  if(hasAcc) n.addAccidental(0,new VF.Accidental("#"));
  if(style) n.setStyle(style);
  return n;
}
function renderStaff(){
  staffEl.innerHTML="";
  renderer = new VF.Renderer(staffEl, VF.Renderer.Backends.SVG);
  renderer.resize(400,200);
  context = renderer.getContext();
  const stave = new VF.Stave(10,40,380);
  stave.addClef(currentClef).setContext(context).draw();
  if (currentNote) {
      const targetNote = createStaveNote(currentNote);
      const voice = new VF.Voice({ num_beats:1, beat_value:4 });
      voice.addTickables([targetNote]);
      new VF.Formatter().joinVoices([voice]).format([voice],300);
      voice.draw(context, stave);
  }
  if(lastWrongNote){
    const wrong = createStaveNote(lastWrongNote,{fillStyle:"red",strokeStyle:"red"});
    const wVoice = new VF.Voice({ num_beats:1, beat_value:4 });
    wVoice.addTickables([wrong]);
    new VF.Formatter().joinVoices([wVoice]).format([wVoice],300);
    wVoice.draw(context, stave);
    const svgNS="http://www.w3.org/2000/svg";
    const cross=document.createElementNS(svgNS,"text");
    cross.setAttribute("x",330); cross.setAttribute("y",52);
    cross.setAttribute("fill","red"); cross.setAttribute("font-size","22");
    cross.textContent="❌";
    staffEl.querySelector("svg").appendChild(cross);
  }
}
function handleNoteInput(noteName, octave){
  if(!isHost || !currentNote) return;
  const targetValue = noteStringToSemitone(currentNote);
  const inputValue = noteStringToSemitone(noteName + "/" + octave);
  if(inputValue === targetValue){
    if(wrongFlashTimeout){ clearTimeout(wrongFlashTimeout); wrongFlashTimeout=null; }
    lastWrongNote = null;
    stats.correct++; stats.streak++; updateStatsUI();
    broadcastState();
    staffEl.classList.remove("flash-wrong");
    staffEl.classList.add("flash-correct");
    setTimeout(()=>staffEl.classList.remove("flash-correct"),400);
    renderStaff();
    setTimeout(randomNote, 500);
  } else {
    // FIX 1: Use the octave from the input argument (octave) for the wrong note display
    lastWrongNote = noteName + "/" + octave; 
    stats.wrong++; stats.streak=0; updateStatsUI();
    broadcastState();
    staffEl.classList.remove("flash-correct");
    staffEl.classList.add("flash-wrong");
    setTimeout(()=>staffEl.classList.remove("flash-wrong"),400);
    renderStaff();
    if(wrongFlashTimeout) clearTimeout(wrongFlashTimeout);
    wrongFlashTimeout = setTimeout(()=>{ 
        if(isHost) {
            lastWrongNote=null; 
            broadcastState();
            renderStaff(); 
            wrongFlashTimeout=null; 
        }
    },1000);
  }
}
function cycleClef(){
  if(!isHost) return;
  const modes = ["treble","bass","both"];
  const idx = modes.indexOf(settings.clefMode);
  settings.clefMode = modes[(idx+1)%modes.length];
  document.getElementById("clefMode").value = settings.clefMode;
  localStorage.setItem("clefMode", settings.clefMode);
  updateSettingsDisplay('host');
  randomNote();
}
function resetStats(){
  if(!isHost) return;
  stats = { correct: 0, wrong: 0, streak: 0 };
  updateStatsUI();
  broadcastState();
}
function setupMIDI(){
  if(!isHost) return;
  if(!navigator.requestMIDIAccess){ enableKeyboard(); return; }
  navigator.requestMIDIAccess().then(midi=>{
    let found=false;
    midi.inputs.forEach(input=>{
      found=true;
      input.onmidimessage=e=>{
        const [cmd,note,vel]=e.data;
        const now = Date.now();
        // True note-on only
        if ((cmd & 0xf0) === 0x90 && vel > 0) {

            // Ignore if key is already considered down
            if (heldKeys[note]) return;

            // Store timestamp for long-press logic
            heldKeys[note] = Date.now();

            // Long press check (special keys only)
            if (note === 21 || note === 23) {
                setTimeout(() => {
                    if (heldKeys[note] && Date.now() - heldKeys[note] > 500) {
                        if (note === 21) cycleClef();
                        if (note === 23) resetStats();
                    }
                }, 500);
                return;
            }

            // Normal note for trainer
            const { note: name, octave } = midiToNoteName(note);
            handleNoteInput(name, octave);
        }

        // NOTE OFF
        if ((cmd & 0xf0) === 0x80 || vel === 0) {
            delete heldKeys[note]; 
        }
        if((cmd&0xf0)===0x80 || vel===0){
          delete heldKeys[note];
        }
      };
    });
    if(!found) enableKeyboard();
  }).catch(enableKeyboard);
}

function enableKeyboard(){
  if(!isHost) return;
  const fb=document.getElementById("fallback");
  if(fb) fb.style.display="block";
  const map={a:"c",w:"c#",s:"d",e:"d#",d:"e",f:"f",t:"f#",g:"g#",h:"a",u:"a#",j:"b",k:"c"};
  
  // The static octaveMap is no longer needed since we derive the octave from the currentNote.
  // const octaveMap = {a:4,w:4,s:4,e:4,d:4,f:4,t:4,g:4,y:4,h:4,u:4,j:4,k:5}; 

  window.addEventListener("keydown", e=>{
    if(!isHost) return;
    
    // Check if there is a note to guess and if the key maps to a note
    const n = map[e.key];
    if(!n || !currentNote) return;

    if(e.key==="a" && e.shiftKey){
      cycleClef();
      return;
    }
    
    // FIX 2: Get the octave from the current target note. 
    // This allows the keyboard input to match the pitch of the displayed note.
    const targetOctave = currentNote.split("/")[1]; 

    handleNoteInput(n, targetOctave);
  });
}

function updateModeDisplay(role) {
    const displayEl = document.getElementById("mode-display");
    if (displayEl) {
        if (role === 'host') {
            displayEl.textContent = "HOST";
            displayEl.style.color = "#8f8"; 
        } else {
            displayEl.textContent = "CLIENT";
            displayEl.style.color = "#88f"; 
        }
    }
}

// NEW FUNCTION: Updates the visible settings display element
function updateSettingsDisplay(role) {
    const displayEl = document.getElementById("settings-display");
    if (!displayEl) return;
    
    let rangeText = settings.maxRange === 0 ? "Default" : `±${settings.maxRange} Octave${settings.maxRange > 1 ? 's' : ''}`;
    let clefText = settings.clefMode.charAt(0).toUpperCase() + settings.clefMode.slice(1);
    let accidentalText = settings.useAccidentals ? "On" : "Off";
    
    // Use innerHTML to allow for bolding (not necessary for this app, but common practice)
    displayEl.innerHTML = `
        Clef: <b>${clefText}</b> | 
        Sharps/Flats: <b>${accidentalText}</b> | 
        Range: <b>${rangeText}</b>
    `;

    // Set color based on role
    if (role === 'host') {
        displayEl.style.color = "#ddd";
    } else {
        displayEl.style.color = "#bbb";
    }
}


// WebSocket Setup Function
function setupWebsocket(role) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return; 
    }

    const url = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws';
    ws = new WebSocket(url);
    requestWakeLock();
    ws.onopen = () => {
        // Reset the flag once the connection is open
        roleSwitching = false; 
        
        ws.send(JSON.stringify({ role: role }));

        if (role === 'host') {
            console.log("Host connected.");
            document.title = "Piano Note Trainer | HOST";
            document.getElementById("controls").style.display = "flex";
            updateModeDisplay('host'); 
            updateSettingsDisplay('host');
            setupMIDI(); 
            randomNote();
        } else {
             console.log("Client connected.");
             document.title = "Piano Note Trainer | CLIENT";
             document.getElementById("controls").style.display = "none";
             updateModeDisplay('client'); 
             updateSettingsDisplay('client'); // Display initial settings from local storage
             renderStaff(); 
        }
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            
            if (data.type === "ERROR") {
                // CRITICAL ROLE SWITCH LOGIC
                if (data.message === "HostAlreadyExists" && role === 'host') {
                    console.log("Host already active. Initiating switch to client role.");
                    isHost = false; 
                    roleSwitching = true; 
                    
                    ws.close(); 
                    
                    connectAsRole('client'); 
                    return;
                }
                
                alert("Error from server: " + data.message);
                return;
            }

            if (data.type === "HOST_DISCONNECTED") {
                alert("The host has disconnected. Refreshing to attempt to become the new host.");
                window.location.reload(); 
                return;
            }

            if (role === 'client') {
                updateState(data); 
            }
            
        } catch(e) {
            console.error("Failed to parse WebSocket message:", e, event.data);
        }
    };

    ws.onclose = () => {
        if (roleSwitching) {
            console.log("Intentional close for role switch.");
            return;
        }

        console.log("WebSocket disconnected unexpectedly. Attempting reconnect in 3s...");
        setTimeout(() => connectAsRole(isHost ? 'host' : 'client'), 3000); 
    };
    
    ws.onerror = (e) => {
        console.error("WebSocket error:", e);
    }
}

// Wrapper function to start the connection process
function connectAsRole(role) {
    if (role === 'host') {
        isHost = true;
    } 
    
    setupWebsocket(role);
}


// --- Init ---

// START: Attempt to connect as host. 
connectAsRole('host');


updateStatsUI();
window.addEventListener("resize",()=>{ renderer.resize(400,200); renderStaff(); });