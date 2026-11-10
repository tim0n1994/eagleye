'use strict';
// Nature's redirects return an HTML interstitial on the native Node transport.
// curl follows its public HTTP redirects using the configured host proxy.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { withFetchRetry } = require('../services/utils');
function fetchFeedCurl(url, {signal,headers,stats,sleep}) {
  return withFetchRetry(async ({signal:attemptSignal}) => {
    const args=['--silent','--show-error','--location','--max-redirs','5','--max-time','25',
      '--proto','=http,https','--proto-redir','=http,https','--suppress-connect-headers','--dump-header','-'];
    for (const [name,value] of Object.entries(headers)) args.push('--header', `${name}: ${value}`);
    args.push(url);
    const {stdout} = await exec('curl',args,{signal:attemptSignal,maxBuffer:4*1024*1024,encoding:'utf8'});
    let body=stdout, status=0, responseHeaders={};
    while (/^HTTP\/\S+ \d{3}/.test(body)) {
      const end=body.search(/\r?\n\r?\n/);
      if (end<0) throw new Error('Invalid curl feed headers');
      const block=body.slice(0,end);
      status=Number(block.match(/^HTTP\/\S+ (\d{3})/)[1]);
      responseHeaders=Object.fromEntries(block.split(/\r?\n/).slice(1).filter(l=>l.includes(':')).map(l=>[l.slice(0,l.indexOf(':')).toLowerCase(),l.slice(l.indexOf(':')+1).trim()]));
      body=body.slice(end).replace(/^\r?\n\r?\n/,'');
    }
    if (status !== 304 && (status<200 || status>=300)) {
      const error=new Error(`RSS upstream HTTP ${status}`);error.upstreamStatus=status;throw error;
    }
    return {body,notModified:status===304,etag:responseHeaders.etag,lastModified:responseHeaders['last-modified']};
  },{signal,stats,sleep,label:url});
}
module.exports={fetchFeedCurl};
