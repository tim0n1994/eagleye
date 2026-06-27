/**
 * Eagleye — Physical AI SEC 8-K Connector
 *
 * Fetches 8-K filings from SEC EDGAR for semiconductor, robotics,
 * photonics, and humanoid-related companies.
 *
 * Uses: https://data.sec.gov/submissions/CIK{10-digit-cik}.json
 * Requires a valid User-Agent header per SEC Fair Access Policy.
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');

// CIKs for companies relevant to Physical AI / semiconductor / robotics
// Format: { ticker: { name, cik, sector } }
const TARGET_COMPANIES = {
  'NVDA': { name: 'NVIDIA Corporation', cik: '0001045810', sector: 'semiconductor' },
  'AMD': { name: 'Advanced Micro Devices', cik: '0000002488', sector: 'semiconductor' },
  'INTC': { name: 'Intel Corporation', cik: '0000050863', sector: 'semiconductor' },
  'TSM': { name: 'Taiwan Semiconductor Manufacturing', cik: '0001046179', sector: 'semiconductor' },
  'MRVL': { name: 'Marvell Technology', cik: '0001835632', sector: 'semiconductor' },
  'MU': { name: 'Micron Technology', cik: '0000723125', sector: 'semiconductor' },
  'TSLA': { name: 'Tesla, Inc.', cik: '0001318605', sector: 'humanoid' },
  'GOOGL': { name: 'Alphabet Inc.', cik: '0001652044', sector: 'robotics' },
  'AMZN': { name: 'Amazon.com, Inc.', cik: '0001018724', sector: 'robotics' },
  'MSFT': { name: 'Microsoft Corporation', cik: '0000789019', sector: 'robotics' },
  'AAPL': { name: 'Apple Inc.', cik: '0000320193', sector: 'photonics' },
  'LRCX': { name: 'Lam Research Corporation', cik: '0000707549', sector: 'semiconductor' },
  'AMAT': { name: 'Applied Materials, Inc.', cik: '0000006951', sector: 'semiconductor' },
  'KLAC': { name: 'KLA Corporation', cik: '0000319201', sector: 'semiconductor' },
  'ASML': { name: 'ASML Holding N.V.', cik: '0000937966', sector: 'semiconductor' },
  'ADI': { name: 'Analog Devices, Inc.', cik: '0000006281', sector: 'semiconductor' },
  'MCHP': { name: 'Microchip Technology Inc.', cik: '0000827054', sector: 'semiconductor' },
  'NXPI': { name: 'NXP Semiconductors N.V.', cik: '0001413447', sector: 'semiconductor' },
  'STM': { name: 'STMicroelectronics N.V.', cik: '0000932794', sector: 'semiconductor' },
  'ROKU': { name: 'Roku, Inc.', cik: '0001428439', sector: 'photonics' },
  'LITE': { name: 'Lumentum Holdings Inc.', cik: '0001638931', sector: 'photonics' },
  'VIAV': { name: 'Viavi Solutions Inc.', cik: '0000912093', sector: 'photonics' },
  'COHR': { name: 'Coherent Corp.', cik: '0001739107', sector: 'photonics' },
  'IIVI': { name: 'II-VI Incorporated', cik: '0000899129', sector: 'photonics' },
  'ROK': { name: 'Rockwell Automation, Inc.', cik: '0000062449', sector: 'robotics' },
  'ABB': { name: 'ABB Ltd', cik: '0001091587', sector: 'robotics' },
  'IRBT': { name: 'iRobot Corporation', cik: '0001159167', sector: 'robotics' },
};

class SEC8KConnector extends BaseConnector {
  constructor() {
    super('physical-ai-sec-8k');
  }

  async fetch(date) {
    const items = [];
    const dateStr = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');

    for (const [ticker, company] of Object.entries(TARGET_COMPANIES)) {
      try {
        const filings = await this._fetchCompanyFilings(company, dateStr);
        items.push(...filings);
        // SEC rate limiting: be respectful
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        if (!err.message.includes('404')) {
          console.warn(`SEC 8-K fetch error for ${ticker}:`, err.message);
        }
      }
    }

    return items;
  }

  async _fetchCompanyFilings(company, dateStr) {
    const url = `https://data.sec.gov/submissions/CIK${company.cik}.json`;
    const body = await fetchURL(url);
    const data = JSON.parse(body);

    const filings = data?.filings?.recent || [];
    const items = [];

    for (const filing of filings) {
      if (filing.form !== '8-K') continue;
      const filingDate = filing.filingDate || '';
      const filingDateStr = filingDate.replace(/-/g, '');
      if (filingDateStr !== dateStr) continue;

      const accessionNo = filing.accessionNumber || '';
      const primaryDoc = filing.primaryDocument || '';
      // parseInt strips leading zeros — SEC EDGAR filesystem uses CIK without leading zeros
      // e.g., CIK 0001045810 → parseInt → 1045810 → correct SEC URL path
      const strippedCik = parseInt(company.cik);
      const docUrl = accessionNo
        ? `https://www.sec.gov/Archives/edgar/data/${strippedCik}/${accessionNo.replace(/-/g, '')}/${primaryDoc}`
        : '';

      items.push({
        ...this.normalize({
          title: `8-K: ${company.name} (${filing.items || 'Form 8-K'})`,
          url: docUrl || `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${company.cik}&type=8-K`,
          description: `${company.name} filed Form 8-K — ${filing.items || 'Current Report'}. Period: ${filing.periodOfReport || 'N/A'}`,
          publishedAt: new Date(filingDate).toISOString(),
          sourcePayload: {
            ticker: Object.keys(TARGET_COMPANIES).find(k => TARGET_COMPANIES[k].cik === company.cik) || '',
            company_name: company.name,
            cik: company.cik,
            sector: company.sector,
            form_type: filing.form,
            items: filing.items || '',
            period_of_report: filing.periodOfReport || '',
            accession_number: accessionNo,
            filing_date: filingDate,
            sec_url: docUrl,
          },
          popularity: {},
          score: 0.5,
        }),
        digest_date: dateStr,
      });
    }

    return items;
  }
}

module.exports = { SEC8KConnector };
