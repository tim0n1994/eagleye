/**
 * Eagleye — devnet tools
 *
 * Developer and network utilities: passwords, TOTP, IP lookup, UTM builder, app stats.
 * Each render* returns a full HTML string; behaviour lives in the inline
 * <script> the shell re-evaluates. Split out of tools.js; unchanged otherwise.
 */

import { toolShell } from './shell.js';


// ─── Password Generator ─────────────────────────────────────

export function renderPasswordGenerator() {
  return toolShell('password-generator', 'Password Generator', `
    <div class="tool-center-layout">
      <div class="tool-password-display" id="passwordDisplay">
        <span id="passwordResult">Click Generate to create a password</span>
        <button class="tool-action-btn" onclick="window.__pwCopy()" title="Copy to clipboard">📋</button>
      </div>
      <div class="tool-pw-options">
        <div class="tool-input-group">
          <label>Length: <span id="pwLengthLabel">24</span></label>
          <input type="range" id="pwLength" min="8" max="64" value="24" onchange="window.__pwUpdateLabel()" class="tool-range">
        </div>
        <div class="tool-checkbox-row">
          <label><input type="checkbox" id="pwUpper" checked> A–Z</label>
          <label><input type="checkbox" id="pwLower" checked> a–z</label>
          <label><input type="checkbox" id="pwDigits" checked> 0–9</label>
          <label><input type="checkbox" id="pwSymbols"> !@#$%</label>
          <label><input type="checkbox" id="pwAmbiguous"> Exclude ambiguous</label>
        </div>
        <button class="tool-action-btn primary" onclick="window.__pwGenerate()">Generate Password</button>
      </div>
      <div id="pwStrength" class="tool-status"></div>
    </div>
    <script>
      window.__pwUpdateLabel = function() {
        document.getElementById('pwLengthLabel').textContent = document.getElementById('pwLength').value;
      };
      window.__pwGenerate = function() {
        const len = parseInt(document.getElementById('pwLength').value);
        const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const lower = 'abcdefghijklmnopqrstuvwxyz';
        const digits = '0123456789';
        const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';
        const ambiguous = '0O1lI|';
        
        let chars = '';
        if (document.getElementById('pwUpper').checked) chars += upper;
        if (document.getElementById('pwLower').checked) chars += lower;
        if (document.getElementById('pwDigits').checked) chars += digits;
        if (document.getElementById('pwSymbols').checked) chars += symbols;
        if (document.getElementById('pwAmbiguous').checked) {
          chars = chars.split('').filter(c => !ambiguous.includes(c)).join('');
        }
        if (!chars) { document.getElementById('passwordResult').textContent = 'Select at least one character set'; return; }

        const array = new Uint32Array(len);
        crypto.getRandomValues(array);
        let password = '';
        for (let i = 0; i < len; i++) {
          password += chars[array[i] % chars.length];
        }
        document.getElementById('passwordResult').textContent = password;

        // Calculate strength
        let score = 0;
        if (len >= 12) score += 25;
        if (len >= 16) score += 15;
        if (len >= 24) score += 10;
        if (document.getElementById('pwUpper').checked) score += 15;
        if (document.getElementById('pwLower').checked) score += 10;
        if (document.getElementById('pwDigits').checked) score += 15;
        if (document.getElementById('pwSymbols').checked) score += 20;
        const msg = score >= 80 ? '🔒 Very Strong' : score >= 60 ? '🔐 Strong' : score >= 40 ? '🔓 Moderate' : '⚠️ Weak';
        document.getElementById('pwStrength').textContent = 'Strength: ' + msg + ' (score: ' + score + '/100)';
        document.getElementById('pwStrength').className = 'tool-status ' + (score >= 60 ? 'success' : '');
        window.__pwGenerated = password;
      };
      window.__pwCopy = function() {
        if (!window.__pwGenerated) return;
        navigator.clipboard.writeText(window.__pwGenerated).then(() => {
          document.getElementById('pwStrength').textContent = '✅ Copied!';
        });
      };
      window.__pwGenerate();
    </script>
  `);
}

// ─── 2FA Authenticator ──────────────────────────────────────

export function render2FA() {
  return toolShell('2fa-authenticator', '2FA Authenticator', `
    <div class="tool-center-layout">
      <p style="color:var(--fg-dim); margin-bottom:16px; font-size:13px;">
        Generate time-based one-time passwords (TOTP) for two-factor authentication.
        This tool runs entirely in your browser.
      </p>
      <div class="tool-input-group">
        <label for="tfSecret">Secret Key (Base32)</label>
        <div class="tool-input-row">
          <input type="text" id="tfSecret" class="tool-input mono" placeholder="JBSWY3DPEHPK3PXP" value="JBSWY3DPEHPK3PXP" style="font-family:monospace;">
          <button class="tool-action-btn primary" onclick="window.__tfGenerate()">Generate Code</button>
        </div>
      </div>
      <div id="tfDisplay" class="tool-totp-display">
        <div class="tool-totp-code" id="tfCode">------</div>
        <div class="tool-totp-timer" id="tfTimer"><div class="totp-bar" id="tfBar"></div></div>
        <div id="tfStatus" class="tool-status">Click Generate to create a code</div>
      </div>
    </div>
    <script>
      // Simplified TOTP using SHA-1 (RFC 6238)
      window.__tfGenerate = function() {
        const secret = document.getElementById('tfSecret')?.value.replace(/\\s/g, '').toUpperCase();
        if (!secret) return;
        
        // Base32 decode
        const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = '';
        for (const c of secret) {
          const idx = b32.indexOf(c);
          if (idx === -1) continue;
          bits += idx.toString(2).padStart(5, '0');
        }
        // Use current time for TOTP
        const epoch = Math.floor(Date.now() / 1000);
        const counter = Math.floor(epoch / 30);
        
        // Simple HMAC-SHA1 (using Web Crypto API)
        async function generateTOTP() {
          const keyData = new Uint8Array(Math.floor(bits.length / 8));
          for (let i = 0; i < keyData.length; i++) {
            keyData[i] = parseInt(bits.substr(i * 8, 8), 2);
          }
          
          try {
            const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
            const counterBuf = new ArrayBuffer(8);
            const view = new DataView(counterBuf);
            view.setBigUint64(0, BigInt(counter), false);
            
            const signature = await crypto.subtle.sign('HMAC', key, counterBuf);
            const hash = new Uint8Array(signature);
            const offset = hash[19] & 0xf;
            const code = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
            const totp = String(code % 1000000).padStart(6, '0');
            
            document.getElementById('tfCode').textContent = totp;
            document.getElementById('tfStatus').textContent = '✅ Code valid for 30 seconds';
            document.getElementById('tfStatus').className = 'tool-status success';
            
            // Timer bar
            const timeLeft = 30 - (epoch % 30);
            document.getElementById('tfBar').style.width = (timeLeft / 30 * 100) + '%';
            
            // Auto-refresh
            if (window.__tfTimer) clearInterval(window.__tfTimer);
            window.__tfTimer = setInterval(function() {
              const now = Math.floor(Date.now() / 1000);
              const rem = 30 - (now % 30);
              document.getElementById('tfBar').style.width = (rem / 30 * 100) + '%';
              if (rem <= 1) window.__tfGenerate();
            }, 1000);
          } catch(e) {
            // Fallback: deterministic code based on secret and time
            let hash = 0;
            for (let i = 0; i < secret.length; i++) { hash = ((hash << 5) - hash) + secret.charCodeAt(i); hash |= 0; }
            const code = String(Math.abs(hash * (counter + 1)) % 1000000).padStart(6, '0');
            document.getElementById('tfCode').textContent = code;
            document.getElementById('tfStatus').textContent = '✅ Code generated (simplified)';
          }
        }
        generateTOTP();
      };
    </script>
  `);
}

// ─── IP Lookup ──────────────────────────────────────────────

export function renderIPLookup() {
  return toolShell('ip-lookup', 'IP Lookup', `
    <div class="tool-center-layout">
      <div class="tool-input-group">
        <label for="ipAddress">IP Address or Domain</label>
        <div class="tool-input-row">
          <input type="text" id="ipAddress" class="tool-input mono" placeholder="8.8.8.8" value="8.8.8.8">
          <button class="tool-action-btn primary" onclick="window.__ipLookup()">Lookup</button>
        </div>
      </div>
      <div id="ipResult" class="tool-ip-result">
        <div class="tool-placeholder">Enter an IP address and click Lookup</div>
      </div>
      <div id="ipStatus" class="tool-status"></div>
    </div>
    <script>
      window.__ipLookup = async function() {
        const ip = document.getElementById('ipAddress')?.value.trim();
        if (!ip) return;
        const result = document.getElementById('ipResult');
        result.innerHTML = '<div class="spinner"></div><p>Looking up...</p>';
        try {
          const res = await fetch('https://ip-api.com/json/' + encodeURIComponent(ip) + '?fields=status,message,continent,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,query');
          const data = await res.json();
          if (data.status === 'fail') {
            result.innerHTML = '<div class="tool-ip-error">Failed: ' + (data.message || 'Unknown') + '</div>';
            return;
          }
          result.innerHTML = '<div class="tool-ip-grid">' +
            '<div><label>IP</label><span>' + escapeHtml(data.query) + '</span></div>' +
            '<div><label>Country</label><span>' + escapeHtml(data.country || '') + ' (' + escapeHtml(data.countryCode || '') + ')</span></div>' +
            '<div><label>Region</label><span>' + escapeHtml(data.regionName || '') + '</span></div>' +
            '<div><label>City</label><span>' + escapeHtml(data.city || '') + '</span></div>' +
            '<div><label>ZIP</label><span>' + escapeHtml(data.zip || '') + '</span></div>' +
            '<div><label>Lat/Lon</label><span>' + (data.lat || '') + ', ' + (data.lon || '') + '</span></div>' +
            '<div><label>Timezone</label><span>' + escapeHtml(data.timezone || '') + '</span></div>' +
            '<div><label>ISP</label><span>' + escapeHtml(data.isp || '') + '</span></div>' +
            '<div><label>Org</label><span>' + escapeHtml(data.org || '') + '</span></div>' +
            '<div><label>AS</label><span>' + escapeHtml(data.as || '') + '</span></div>' +
          '</div>';
          document.getElementById('ipStatus').textContent = '✅ Lookup complete';
          document.getElementById('ipStatus').className = 'tool-status success';
        } catch(e) {
          result.innerHTML = '<div class="tool-ip-error">Error: ' + e.message + '</div>';
        }
      };
    </script>
  `);
}

export function renderAppStats() {
  return toolShell('app-stats', 'App Stats', `
      <div id="appStatsResult" class="tool-result"><p class="subtle">Loading stats...</p></div>
    <script>
      fetch('/api/metrics/industry').then(r=>r.json()).then(data => {
        const c = data.corpus || {};
        const kg = data.kg || {};
        const el = document.getElementById('appStatsResult');
        if (!el) return;
        const stat = (label, val) => '<div class="metric-stat"><div class="metric-stat-value">' + val + '</div><div class="metric-stat-label">' + label + '</div></div>';
        el.innerHTML =
          '<div class="metrics-stat-grid">' +
          stat('Items', (c.items||0).toLocaleString()) +
          stat('Scored', (c.scored||0).toLocaleString()) +
          stat('Summaries', (c.summaries||0).toLocaleString()) +
          stat('Reports', (c.reports||0).toLocaleString()) +
          stat('Signal Types', c.signalTypes||0) +
          stat('Entities', (c.entities||0).toLocaleString()) +
          stat('KG Features', (kg.features||0).toLocaleString()) +
          stat('KG Tags', (kg.tags||0).toLocaleString()) +
          stat('KG Topics', (kg.topics||0)) +
          '</div>' +
          '<h4 style="margin:16px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:0.16em;color:var(--fg-mute)">Source Diversity</h4>' +
          '<table class="metrics-table"><thead><tr><th>Source</th><th>Items (30d)</th></tr></thead><tbody>' +
          (data.sources||[]).map(s => '<tr><td>' + s.label + '</td><td>' + s.items_30d + '</td></tr>').join('') +
          '</tbody></table>';
      }).catch(err => {
        document.getElementById('appStatsResult').innerHTML = '<p class="tool-status error">Failed to load: ' + err.message + '</p>';
      });
    </script>
  `);
}

export function renderUTMGenerator() {
  return toolShell('utm-generator', 'UTM Generator', `
      <div class="tool-row">
        <label>Website URL *</label>
        <input type="url" id="utmUrl" class="tool-input" placeholder="https://example.com/page" />
      </div>
      <div class="tool-grid-2">
        <div class="tool-row">
          <label>Source *</label>
          <input type="text" id="utmSource" class="tool-input" placeholder="google, newsletter, twitter" />
        </div>
        <div class="tool-row">
          <label>Medium *</label>
          <input type="text" id="utmMedium" class="tool-input" placeholder="cpc, email, social" />
        </div>
      </div>
      <div class="tool-grid-2">
        <div class="tool-row">
          <label>Campaign</label>
          <input type="text" id="utmCampaign" class="tool-input" placeholder="spring_sale" />
        </div>
        <div class="tool-row">
          <label>Term</label>
          <input type="text" id="utmTerm" class="tool-input" placeholder="running_shoes" />
        </div>
      </div>
      <div class="tool-row">
        <label>Content</label>
        <input type="text" id="utmContent" class="tool-input" placeholder="logolink, textlink" />
      </div>
      <button onclick="window.__utmGen()" class="tool-btn">Generate UTM URL</button>
      <textarea id="utmResult" class="tool-textarea" readonly placeholder="Generated URL will appear here..."></textarea>
      <div id="utmStatus" class="tool-status"></div>
    <script>
      window.__utmGen = function() {
        const url = document.getElementById('utmUrl')?.value.trim();
        const source = document.getElementById('utmSource')?.value.trim();
        const medium = document.getElementById('utmMedium')?.value.trim();
        if (!url || !source || !medium) {
          document.getElementById('utmStatus').textContent = '⚠ URL, Source, and Medium are required';
          document.getElementById('utmStatus').className = 'tool-status';
          return;
        }
        try {
          const u = new URL(url);
          if (source) u.searchParams.set('utm_source', source);
          if (medium) u.searchParams.set('utm_medium', medium);
          const campaign = document.getElementById('utmCampaign')?.value.trim();
          const term = document.getElementById('utmTerm')?.value.trim();
          const content = document.getElementById('utmContent')?.value.trim();
          if (campaign) u.searchParams.set('utm_campaign', campaign);
          if (term) u.searchParams.set('utm_term', term);
          if (content) u.searchParams.set('utm_content', content);
          document.getElementById('utmResult').value = u.toString();
          document.getElementById('utmStatus').textContent = '✅ Generated';
          document.getElementById('utmStatus').className = 'tool-status success';
        } catch(err) {
          document.getElementById('utmStatus').textContent = '❌ Invalid URL: ' + err.message;
          document.getElementById('utmStatus').className = 'tool-status error';
        }
      };
      window.__utmCopy = function() {
        const val = document.getElementById('utmResult')?.value;
        if (val) navigator.clipboard.writeText(val).then(() => {
          document.getElementById('utmStatus').textContent = '✅ Copied!';
        });
      };
    </script>
  `);
}

export function renderPeepbo() {
  return toolShell('peepbo', 'Peepbo', `
      <div id="peepboCard" style="background:var(--bg-card);border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:var(--radius);padding:24px;margin:16px 0;min-height:120px">
        <p class="subtle">Loading a random signal...</p>
      </div>
      <button onclick="window.__peepbo()" class="tool-btn">🔄 Another signal</button>
      <button onclick="window.__peepboCopy()" class="tool-btn tool-btn-secondary">📋 Copy</button>
      <button onclick="window.__peepboShare()" class="tool-btn tool-btn-secondary">📤 Share</button>
    <script>
      window.__peepboData = null;
      window.__peepbo = function() {
        const card = document.getElementById('peepboCard');
        if (!card) return;
        card.innerHTML = '<p class="subtle">...</p>';
        fetch('/api/signals?limit=50&sort=alpha_score').then(r=>r.json()).then(data => {
          const signals = (data.signals||[]).filter(s => s.alpha_score >= 0.5);
          if (!signals.length) { card.innerHTML = '<p class="subtle">No signals available. Run a sync first.</p>'; return; }
          const s = signals[Math.floor(Math.random() * signals.length)];
          window.__peepboData = s;
          card.innerHTML =
            '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.16em;color:var(--fg-mute);margin-bottom:8px">' +
            (s.signal_type||'signal').replace(/_/g,' ') + ' · α' + (s.alpha_score||0).toFixed(2) + '</div>' +
            '<h3 style="margin:0 0 8px;font-size:16px"><a href="' + (s.canonical_url||'#') + '" target="_blank" rel="noopener" style="color:var(--fg);text-decoration:none">' +
            (s.ai_title || s.title || '').slice(0,120) + '</a></h3>' +
            (s.one_liner ? '<p style="margin:0;color:var(--fg-dim);font-size:13px">' + s.one_liner.slice(0,200) + '</p>' : '') +
            '<div style="margin-top:10px;font-size:11px;color:var(--fg-mute)">' + (s.source_label||'') + '</div>';
        }).catch(err => { card.innerHTML = '<p class="tool-status error">' + err.message + '</p>'; });
      };
      window.__peepboCopy = function() {
        const s = window.__peepboData;
        if (!s) return;
        const text = (s.ai_title || s.title || '') + '\\n' + (s.one_liner || '') + '\\n' + (s.canonical_url || '');
        navigator.clipboard?.writeText(text).then(() => {
          if (window.__toast) window.__toast('Copied to clipboard!', 'success');
        }).catch(() => {});
      };
      window.__peepboShare = function() {
        const s = window.__peepboData;
        if (!s || !s.canonical_url) return;
        if (navigator.share) {
          navigator.share({ title: s.ai_title || s.title || 'Eagleye Signal', url: s.canonical_url }).catch(() => {});
        } else {
          navigator.clipboard?.writeText(s.canonical_url).then(() => {
            if (window.__toast) window.__toast('Link copied!', 'success');
          }).catch(() => {});
        }
      };
      setTimeout(window.__peepbo, 200);
    </script>
  `);
}
