const billing=require('../services/billing');
const {sendJSON,sendError,readBody}=require('./_shared');
module.exports=routes=>{
  routes['/api/billing/plans']=(req,res)=>sendJSON(res,200,billing.catalog());
  routes['/api/billing/status']=(req,res)=>sendJSON(res,200,billing.status(req.user));
  for (const action of ['checkout','portal']) routes['/api/billing/'+action]=async(req,res)=>{
    if(req.method!=='POST')return sendError(res,405,'Method not allowed');
    // JSON plus same-origin browser checks; provider callbacks use a separate route.
    if(!String(req.headers['content-type']).startsWith('application/json'))return sendError(res,415,'JSON required');
    if(req.headers['sec-fetch-site']==='cross-site')return sendError(res,403,'Cross-site request rejected');
    try{
      const body=await readBody(req);
      const result=action==='checkout'?await billing.checkout(req.user,body.plan,/^zh/i.test(req.headers['accept-language']||'')?'zh':'en'):await billing.portal(req.user);
      res.setHeader('Cache-Control','no-store');sendJSON(res,200,result);
    }catch(error){sendError(res,error.status||502,error.status?error.message:'Payment provider is unavailable. Please retry.');}
  };
  routes['/api/billing/webhook']=async(req,res)=>{
    if(req.method!=='POST')return sendError(res,405,'Method not allowed');
    try{
      const parts=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>262144)return sendError(res,413,'Payload too large');parts.push(chunk);}
      const result=billing.acceptWebhook(Buffer.concat(parts).toString('utf8'),req.headers['x-waffo-signature']);
      sendJSON(res,200,result);
    }catch(error){sendError(res,error.status||500,error.status?error.message:'Payment processing failed');}
  };
};
