/**
 * Eagleye — calc tools
 *
 * Calculators and converters: units, mortgage, HELOC, leverage, stopwatch, timezones.
 * Each render* returns a full HTML string; behaviour lives in the inline
 * <script> the shell re-evaluates. Split out of tools.js; unchanged otherwise.
 */

import { toolShell } from './shell.js';


// ─── Unit Converter ─────────────────────────────────────────

export function renderUnitConverter() {
  return toolShell('unit-converter', 'Unit Converter', `
    <div class="tool-center-layout">
      <div class="tool-input-group">
        <label>Category</label>
        <select id="ucCategory" class="tool-select" onchange="window.__ucUpdate()">
          <option value="length">Length</option>
          <option value="mass">Mass / Weight</option>
          <option value="temperature">Temperature</option>
          <option value="data">Data Size</option>
          <option value="speed">Speed</option>
          <option value="volume">Volume</option>
        </select>
      </div>
      <div class="tool-converter">
        <div class="tool-conv-row">
          <input type="number" id="ucValue" class="tool-input mono" value="1" oninput="window.__ucConvert()">
          <select id="ucFrom" class="tool-select" onchange="window.__ucConvert()"></select>
        </div>
        <div class="tool-conv-arrow">⇅</div>
        <div class="tool-conv-row">
          <input type="number" id="ucResult" class="tool-input mono" readonly>
          <select id="ucTo" class="tool-select" onchange="window.__ucConvert()"></select>
        </div>
      </div>
      <div id="ucStatus" class="tool-status"></div>
    </div>
    <script>
      const ucUnits = {
        length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.34, yd: 0.9144, ft: 0.3048, in: 0.0254, 'nmi': 1852 },
        mass: { kg: 1, g: 0.001, mg: 1e-6, lb: 0.453592, oz: 0.0283495, t: 1000, st: 6.35029 },
        temperature: { '°C': 'c', '°F': 'f', K: 'k' },
        data: { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776, kb: 125, Mb: 125000, Gb: 125000000 },
        speed: { 'm/s': 1, 'km/h': 0.277778, 'mph': 0.44704, kn: 0.514444, c: 299792458 },
        volume: { L: 1, mL: 0.001, gal: 3.78541, qt: 0.946353, pt: 0.473176, cup: 0.236588, 'fl oz': 0.0295735, 'm³': 1000 }
      };
      window.__ucUpdate = function() {
        const cat = document.getElementById('ucCategory').value;
        const units = Object.keys(ucUnits[cat]);
        const fromSel = document.getElementById('ucFrom');
        const toSel = document.getElementById('ucTo');
        fromSel.innerHTML = units.map(u => '<option value="' + u + '">' + u + '</option>').join('');
        toSel.innerHTML = units.map(u => '<option value="' + u + '">' + u + '</option>').join('');
        toSel.value = units[1] || units[0];
        window.__ucConvert();
      };
      window.__ucConvert = function() {
        const cat = document.getElementById('ucCategory').value;
        const val = parseFloat(document.getElementById('ucValue').value);
        const from = document.getElementById('ucFrom').value;
        const to = document.getElementById('ucTo').value;
        if (isNaN(val)) return;
        let result;
        if (cat === 'temperature') {
          let c;
          if (from === '°C') c = val;
          else if (from === '°F') c = (val - 32) * 5/9;
          else c = val - 273.15;
          if (to === '°C') result = c;
          else if (to === '°F') result = c * 9/5 + 32;
          else result = c + 273.15;
        } else {
          const units = ucUnits[cat];
          result = val * units[from] / units[to];
        }
        document.getElementById('ucResult').value = result.toFixed(6).replace(/0+$/, '').replace(/\\.$/, '');
        document.getElementById('ucStatus').textContent = val + ' ' + from + ' = ' + document.getElementById('ucResult').value + ' ' + to;
      };
      window.__ucUpdate();
    </script>
  `);
}

// ─── Chronograph ────────────────────────────────────────────

export function renderChronograph() {
  return toolShell('chronograph', 'Chronograph', `
    <div class="tool-center-layout">
      <div class="tool-chrono-display" id="chronoDisplay">00:00.000</div>
      <div class="tool-chrono-controls">
        <button id="chronoStartBtn" class="tool-action-btn primary" onclick="window.__chronoStart()">Start</button>
        <button class="tool-action-btn" onclick="window.__chronoLap()">Lap</button>
        <button class="tool-action-btn" onclick="window.__chronoStop()">Stop</button>
        <button class="tool-action-btn" onclick="window.__chronoReset()">Reset</button>
      </div>
      <div class="tool-chrono-laps" id="chronoLaps"></div>
    </div>
    <script>
      let __chronoRunning = false, __chronoStartTime = 0, __chronoElapsed = 0, __chronoInterval = null, __chronoLapCount = 0, __chronoLastLap = 0;
      window.__chronoStart = function() {
        if (__chronoRunning) return;
        __chronoRunning = true;
        __chronoStartTime = Date.now() - __chronoElapsed;
        __chronoInterval = setInterval(function() {
          __chronoElapsed = Date.now() - __chronoStartTime;
          document.getElementById('chronoDisplay').textContent = __chronoFormat(__chronoElapsed);
        }, 10);
        document.getElementById('chronoStartBtn').textContent = 'Running...';
        document.getElementById('chronoStartBtn').style.opacity = '0.5';
      };
      window.__chronoStop = function() {
        if (!__chronoRunning) return;
        __chronoRunning = false;
        clearInterval(__chronoInterval);
        document.getElementById('chronoStartBtn').textContent = 'Resume';
        document.getElementById('chronoStartBtn').style.opacity = '1';
      };
      window.__chronoReset = function() {
        __chronoRunning = false;
        clearInterval(__chronoInterval);
        __chronoElapsed = 0; __chronoLapCount = 0; __chronoLastLap = 0;
        document.getElementById('chronoDisplay').textContent = '00:00.000';
        document.getElementById('chronoStartBtn').textContent = 'Start';
        document.getElementById('chronoStartBtn').style.opacity = '1';
        document.getElementById('chronoLaps').innerHTML = '';
      };
      window.__chronoLap = function() {
        if (!__chronoRunning) return;
        __chronoLapCount++;
        const lapTime = __chronoElapsed - __chronoLastLap;
        const total = __chronoElapsed;
        __chronoLastLap = __chronoElapsed;
        const div = document.createElement('div');
        div.className = 'chrono-lap-row';
        div.innerHTML = '<span>Lap ' + __chronoLapCount + '</span><span>' + __chronoFormat(lapTime) + '</span><span>' + __chronoFormat(total) + '</span>';
        document.getElementById('chronoLaps').prepend(div);
      };
      function __chronoFormat(ms) {
        const min = Math.floor(ms / 60000);
        const sec = Math.floor((ms % 60000) / 1000);
        const millis = ms % 1000;
        return String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0') + '.' + String(millis).padStart(3, '0');
      }
    </script>
  `);
}

// ─── Mortgage Calculator ────────────────────────────────────

export function renderMortgageCalc() {
  return toolShell('mortgage-calculator', 'Mortgage Calculator', `
    <div class="tool-center-layout">
      <div class="tool-calc-grid">
        <div class="tool-input-group">
          <label>Loan Amount ($)</label>
          <input type="number" id="mcAmount" class="tool-input mono" value="500000" oninput="window.__mcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Interest Rate (%)</label>
          <input type="number" id="mcRate" class="tool-input mono" value="6.5" step="0.1" oninput="window.__mcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Loan Term (years)</label>
          <input type="number" id="mcTerm" class="tool-input mono" value="30" oninput="window.__mcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Down Payment ($)</label>
          <input type="number" id="mcDown" class="tool-input mono" value="100000" oninput="window.__mcCalc()">
        </div>
      </div>
      <div id="mcResults" class="tool-calc-results"></div>
    </div>
    <script>
      window.__mcCalc = function() {
        const amount = parseFloat(document.getElementById('mcAmount').value) || 0;
        const rate = (parseFloat(document.getElementById('mcRate').value) || 0) / 100 / 12;
        const termMonths = (parseInt(document.getElementById('mcTerm').value) || 0) * 12;
        const down = parseFloat(document.getElementById('mcDown').value) || 0;
        const principal = amount - down;
        
        if (principal <= 0 || rate <= 0 || termMonths <= 0) {
          document.getElementById('mcResults').innerHTML = '<p style="color:var(--fg-mute)">Enter valid numbers to calculate</p>';
          return;
        }
        
        const payment = principal * rate * Math.pow(1 + rate, termMonths) / (Math.pow(1 + rate, termMonths) - 1);
        const totalPaid = payment * termMonths;
        const totalInterest = totalPaid - principal;
        
        document.getElementById('mcResults').innerHTML = '<div class="calc-result-grid">' +
          '<div class="calc-result-item highlight"><label>Monthly Payment</label><span>$' + payment.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Total Payment</label><span>$' + totalPaid.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Total Interest</label><span>$' + totalInterest.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Down Payment</label><span>$' + down.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Loan Amount</label><span>$' + principal.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Interest/Principal</label><span>' + (totalInterest/principal*100).toFixed(1) + '%</span></div>' +
        '</div>';
      };
      window.__mcCalc();
    </script>
  `);
}

// ─── HELOC Calculator ───────────────────────────────────────

export function renderHELOC() {
  return toolShell('heloc-calculator', 'HELOC Calculator', `
    <div class="tool-center-layout">
      <div class="tool-calc-grid">
        <div class="tool-input-group">
          <label>Home Value ($)</label>
          <input type="number" id="hcHomeValue" class="tool-input mono" value="600000" oninput="window.__hcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Existing Mortgage ($)</label>
          <input type="number" id="hcMortgage" class="tool-input mono" value="300000" oninput="window.__hcCalc()">
        </div>
        <div class="tool-input-group">
          <label>CLTV Ratio (%)</label>
          <input type="number" id="hcCLTV" class="tool-input mono" value="80" oninput="window.__hcCalc()">
        </div>
        <div class="tool-input-group">
          <label>HELOC Rate (%)</label>
          <input type="number" id="hcRate" class="tool-input mono" value="8.5" step="0.1" oninput="window.__hcCalc()">
        </div>
      </div>
      <div id="hcResults" class="tool-calc-results"></div>
    </div>
    <script>
      window.__hcCalc = function() {
        const homeValue = parseFloat(document.getElementById('hcHomeValue').value) || 0;
        const mortgage = parseFloat(document.getElementById('hcMortgage').value) || 0;
        const cltv = (parseFloat(document.getElementById('hcCLTV').value) || 80) / 100;
        const rate = (parseFloat(document.getElementById('hcRate').value) || 0) / 100;
        
        const maxTotal = homeValue * cltv;
        const availableHELOC = Math.max(0, maxTotal - mortgage);
        const monthlyInterest = availableHELOC * rate / 12;
        
        document.getElementById('hcResults').innerHTML = '<div class="calc-result-grid">' +
          '<div class="calc-result-item highlight"><label>Available HELOC</label><span>$' + availableHELOC.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Home Value</label><span>$' + homeValue.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Existing Mortgage</label><span>$' + mortgage.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Max Total (CLTV)</label><span>$' + maxTotal.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Est. Monthly Interest</label><span>$' + monthlyInterest.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Available Equity</label><span>$' + (homeValue - mortgage).toFixed(2) + '</span></div>' +
        '</div>';
      };
      window.__hcCalc();
    </script>
  `);
}

// ─── Leverage Calculator ────────────────────────────────────

export function renderLeverageCalc() {
  return toolShell('leverage-calculator', 'Leverage Calculator', `
    <div class="tool-center-layout">
      <div class="tool-calc-grid">
        <div class="tool-input-group">
          <label>Investment Amount ($)</label>
          <input type="number" id="lcAmount" class="tool-input mono" value="10000" oninput="window.__lcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Leverage Ratio</label>
          <input type="number" id="lcLeverage" class="tool-input mono" value="3" step="0.5" oninput="window.__lcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Return (%)</label>
          <input type="number" id="lcReturn" class="tool-input mono" value="10" oninput="window.__lcCalc()">
        </div>
        <div class="tool-input-group">
          <label>Interest Rate (%)</label>
          <input type="number" id="lcInterest" class="tool-input mono" value="5" step="0.5" oninput="window.__lcCalc()">
        </div>
      </div>
      <div id="lcResults" class="tool-calc-results"></div>
    </div>
    <script>
      window.__lcCalc = function() {
        const amount = parseFloat(document.getElementById('lcAmount').value) || 0;
        const leverage = parseFloat(document.getElementById('lcLeverage').value) || 1;
        const ret = (parseFloat(document.getElementById('lcReturn').value) || 0) / 100;
        const interest = (parseFloat(document.getElementById('lcInterest').value) || 0) / 100;
        
        const borrowed = amount * (leverage - 1);
        const totalExposure = amount * leverage;
        const gain = totalExposure * ret;
        const interestCost = borrowed * interest;
        const netReturn = gain - interestCost;
        const returnOnEquity = (netReturn / amount) * 100;
        const isPositive = netReturn >= 0;
        
        document.getElementById('lcResults').innerHTML = '<div class="calc-result-grid">' +
          '<div class="calc-result-item ' + (isPositive ? 'highlight' : '') + '"><label>Net Return</label><span style="color:' + (isPositive ? 'var(--accent)' : '#ff4757') + '">$' + netReturn.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Total Exposure</label><span>$' + totalExposure.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Borrowed Amount</label><span>$' + borrowed.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Gross Return</label><span>$' + gain.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Interest Cost</label><span>$' + interestCost.toFixed(2) + '</span></div>' +
          '<div class="calc-result-item"><label>Return on Equity</label><span>' + returnOnEquity.toFixed(2) + '%</span></div>' +
        '</div>';
      };
      window.__lcCalc();
    </script>
  `);
}

export function renderTimezoneConverter() {
  return `
    <div class="tool-container">
      <div class="tool-header">
        <h2>🌍 Timezone Converter</h2>
        <p class="tool-desc">Convert a time across timezones. Enter a time, pick source + target zones.</p>
      </div>
      <div class="tool-row">
        <label>Time</label>
        <input type="datetime-local" id="tzInput" class="tool-input" />
      </div>
      <div class="tool-row">
        <label>From</label>
        <select id="tzFrom" class="tool-select">
          ${['UTC','America/New_York','America/Los_Angeles','America/Chicago','Europe/London','Europe/Paris','Europe/Berlin','Asia/Shanghai','Asia/Tokyo','Asia/Singapore','Asia/Kolkata','Australia/Sydney','Pacific/Auckland'].map(tz => `<option value="${tz}">${tz}</option>`).join('')}
        </select>
      </div>
      <div class="tool-row">
        <label>To</label>
        <select id="tzTo" class="tool-select">
          ${['UTC','America/New_York','America/Los_Angeles','America/Chicago','Europe/London','Europe/Paris','Europe/Berlin','Asia/Shanghai','Asia/Tokyo','Asia/Singapore','Asia/Kolkata','Australia/Sydney','Pacific/Auckland'].map(tz => `<option value="${tz}">${tz}</option>`).join('')}
        </select>
      </div>
      <button onclick="window.__tzConvert()" class="tool-btn">Convert</button>
      <div id="tzResult" class="tool-result"></div>
    </div>
    <script>
      window.__tzConvert = function() {
        const input = document.getElementById('tzInput')?.value;
        if (!input) { document.getElementById('tzResult').innerHTML = '<p class="tool-status">⚠ Pick a date/time</p>'; return; }
        const fromTz = document.getElementById('tzFrom').value;
        const toTz = document.getElementById('tzTo').value;
        try {
          // Parse the datetime-local input as if it's in the "from" timezone.
          // datetime-local gives "YYYY-MM-DDTHH:MM" with no tz offset.
          const dateStr = input.length === 16 ? input : input + ':00';
          // Construct an ISO string and use the browser's Intl to format.
          // Trick: create the date, then use the offset difference.
          const dt = new Date(dateStr + 'Z');
          // Compute the from-tz offset at that instant.
          const fromFmt = new Intl.DateTimeFormat('en-US', { timeZone: fromTz, timeZoneName: 'shortOffset' }).formatToParts(dt);
          const fromOffsetPart = fromFmt.find(p => p.type === 'timeZoneName')?.value || '';
          const toFmt = new Intl.DateTimeFormat('en-US', { timeZone: toTz, dateStyle: 'full', timeStyle: 'long' }).format(dt);
          const fromDisp = new Intl.DateTimeFormat('en-US', { timeZone: fromTz, dateStyle: 'full', timeStyle: 'long' }).format(dt);
          document.getElementById('tzResult').innerHTML =
            '<div class="tool-output-group">' +
            '<div class="tool-output-label">' + fromTz + '</div>' +
            '<div class="tool-output-value">' + fromDisp + '</div>' +
            '</div><div class="tool-output-group">' +
            '<div class="tool-output-label">' + toTz + '</div>' +
            '<div class="tool-output-value">' + toFmt + '</div>' +
            '</div>';
        } catch(err) {
          document.getElementById('tzResult').innerHTML = '<p class="tool-status error">❌ ' + err.message + '</p>';
        }
      };
    </script>
  `;
}
