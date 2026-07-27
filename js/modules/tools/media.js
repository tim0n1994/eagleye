/**
 * Eagleye — media tools
 *
 * Audio and video tools, plus the guidance cards for jobs better done by ffmpeg/HandBrake.
 * Each render* returns a full HTML string; behaviour lives in the inline
 * <script> the shell re-evaluates. Split out of tools.js; unchanged otherwise.
 */

import { toolShell } from './shell.js';




export function renderVideoCompressor() {
  return toolShell('video-compressor', 'Video Compressor', `
<p>Browser-based video encoding is too resource-intensive for a local tool. We recommend:</p><ul style="margin:12px 0;padding-left:20px;line-height:2"><li><strong>HandBrake</strong> — free, open-source video transcoder (handbrake.fr)</li><li><strong>ffmpeg</strong> — <code>ffmpeg -i input.mp4 -crf 28 output.mp4</code></li></ul>
  `);
}

export function renderVideoToGIF() {
  return toolShell('video-to-gif', 'Video to GIF', `
<p>Convert video to GIF with ffmpeg or an online tool:</p><ul style="margin:12px 0;padding-left:20px;line-height:2"><li><strong>ffmpeg</strong> — <code>ffmpeg -i input.mp4 -vf "fps=10,scale=320:-1" output.gif</code></li><li><strong>ezgif.com</strong> — browser-based, no install</li></ul>
  `);
}

export function renderAudioCompressor() {
  return toolShell('audio-compressor', 'Audio Compressor', `
<p>Compress audio with ffmpeg or Audacity:</p><ul style="margin:12px 0;padding-left:20px;line-height:2"><li><strong>ffmpeg</strong> — <code>ffmpeg -i input.wav -b:a 128k output.mp3</code></li><li><strong>Audacity</strong> — free, open-source audio editor</li></ul>
  `);
}

export function renderMediaConverter() {
  return toolShell('media-converter', 'Media Converter', `
<p>For format conversion across media types:</p><ul style="margin:12px 0;padding-left:20px;line-height:2"><li><strong>ffmpeg</strong> — handles video/audio/image conversion</li><li><strong>CloudConvert</strong> — browser-based, 200+ formats</li></ul><p class="subtle">Image-only conversion? Use our <a href="/tools/image-converter">Image Converter</a> tool (runs locally in browser).</p>
  `);
}

export function renderAudioExtractor() {
  return toolShell('audio-extractor', 'Audio Extractor', `
      <div class="tool-row">
        <label>Select Video</label>
        <input type="file" id="audioExtractFile" accept="video/*" class="tool-input" />
      </div>
      <button onclick="window.__extractAudio()" class="tool-btn" id="audioExtractBtn" style="display:none">Extract Audio</button>
      <div id="audioExtractResult" class="tool-result"></div>
    <script>
      document.getElementById('audioExtractFile')?.addEventListener('change', function(e) {
        const hasFile = !!e.target.files[0];
        document.getElementById('audioExtractBtn').style.display = hasFile ? 'block' : 'none';
        if (hasFile) {
          const f = e.target.files[0];
          document.getElementById('audioExtractResult').innerHTML = '<p class="subtle">Selected: ' + f.name + ' (' + (f.size/1048576).toFixed(1) + ' MB)</p>';
        }
      });
      window.__extractAudio = async function() {
        const file = document.getElementById('audioExtractFile')?.files[0];
        if (!file) return;
        const result = document.getElementById('audioExtractResult');
        result.innerHTML = '<p class="subtle">Extracting audio... (this may take a moment)</p>';
        try {
          // Create a video element to decode the file, capture its audio track.
          const video = document.createElement('video');
          video.src = URL.createObjectURL(file);
          video.muted = false;
          await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });

          // Use captureStream to grab the audio.
          if (!video.captureStream) { throw new Error('captureStream not supported in this browser'); }
          const stream = video.captureStream();
          const audioTracks = stream.getAudioTracks();
          if (audioTracks.length === 0) { throw new Error('No audio track found in this video'); }

          const audioStream = new MediaStream(audioTracks);
          const recorder = new MediaRecorder(audioStream);
          const chunks = [];
          recorder.ondataavailable = function(e) { if (e.data.size > 0) chunks.push(e.data); };
          recorder.onstop = function() {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            const url = URL.createObjectURL(blob);
            const sizeKB = (blob.size / 1024).toFixed(0);
            const baseName = file.name.replace(/[.][^.]+$/, '');
            result.innerHTML =
              '<p class="subtle">Extracted audio: ' + sizeKB + ' KB</p>' +
              '<audio src="' + url + '" controls style="width:100%;margin:8px 0"></audio>' +
              '<a href="' + url + '" download="' + baseName + '-audio.webm" class="tool-btn" style="display:inline-block">⬇ Download audio</a>';
            URL.revokeObjectURL(video.src);
          };
          recorder.start();
          video.play();
          video.onended = function() { if (recorder.state !== 'inactive') recorder.stop(); };
        } catch(err) {
          result.innerHTML = '<p class="tool-status error">❌ ' + err.message + '</p>';
        }
      };
    </script>
  `);
}

export function renderVoiceRecorder() {
  return toolShell('voice-recorder', 'Voice Recorder', `
      <div class="tool-recorder-area">
        <div id="recStatus" class="rec-status">Ready</div>
        <div id="recTimer" class="rec-timer">00:00</div>
        <div class="rec-controls">
          <button id="recStart" onclick="window.__recStart()" class="tool-btn">● Record</button>
          <button id="recStop" onclick="window.__recStop()" class="tool-btn tool-btn-secondary" disabled>■ Stop</button>
        </div>
      </div>
      <div id="recResult" class="rec-result"></div>
      <audio id="recPlayer" controls style="display:none; width:100%; margin-top:12px;"></audio>
    <script>
      window.__recState = { mediaRecorder: null, chunks: [], startTime: 0, timer: null, stream: null };
      window.__recStart = async function() {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          window.__recState.stream = stream;
          window.__recState.chunks = [];
          const mr = new MediaRecorder(stream);
          window.__recState.mediaRecorder = mr;
          mr.ondataavailable = function(e) { if (e.data.size > 0) window.__recState.chunks.push(e.data); };
          mr.onstop = function() {
            const blob = new Blob(window.__recState.chunks, { type: 'audio/webm' });
            const url = URL.createObjectURL(blob);
            const player = document.getElementById('recPlayer');
            player.src = url;
            player.style.display = 'block';
            const sizeKB = (blob.size / 1024).toFixed(0);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'recording-' + Date.now() + '.webm';
            a.textContent = '⬇ Download recording (' + sizeKB + ' KB)';
            a.className = 'tool-btn';
            const result = document.getElementById('recResult');
            result.innerHTML = '';
            result.appendChild(a);
            document.getElementById('recStatus').textContent = 'Recording saved (' + sizeKB + ' KB)';
            document.getElementById('recStatus').className = 'rec-status success';
            stream.getTracks().forEach(t => t.stop());
          };
          mr.start();
          window.__recState.startTime = Date.now();
          document.getElementById('recStart').disabled = true;
          document.getElementById('recStop').disabled = false;
          document.getElementById('recStatus').textContent = '🔴 Recording...';
          document.getElementById('recStatus').className = 'rec-status recording';
          window.__recState.timer = setInterval(function() {
            const elapsed = Math.floor((Date.now() - window.__recState.startTime) / 1000);
            const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const s = String(elapsed % 60).padStart(2, '0');
            document.getElementById('recTimer').textContent = m + ':' + s;
          }, 1000);
        } catch(err) {
          document.getElementById('recStatus').textContent = '❌ Microphone access denied: ' + err.message;
          document.getElementById('recStatus').className = 'rec-status error';
        }
      };
      window.__recStop = function() {
        if (window.__recState.mediaRecorder && window.__recState.mediaRecorder.state !== 'inactive') {
          window.__recState.mediaRecorder.stop();
        }
        if (window.__recState.timer) clearInterval(window.__recState.timer);
        document.getElementById('recStart').disabled = false;
        document.getElementById('recStop').disabled = true;
      };
    </script>
  `);
}
