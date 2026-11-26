import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { buildSite } from "./scripts/build-site.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(__dirname, "dist");
const DATA_DIR = process.env.PUMPFIAT_DATA_DIR || path.join(__dirname, "data");
const DB_PATH = process.env.PUMPFIAT_DB_PATH || path.join(DATA_DIR, "pumpfiat.sqlite");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  registration_email TEXT NOT NULL,
  normalized_registration_email TEXT NOT NULL UNIQUE,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by_participant_id INTEGER,
  gumroad_affiliate_email TEXT,
  normalized_gumroad_affiliate_email TEXT,
  gumroad_profile_url TEXT,
  gumroad_reported_status TEXT NOT NULL DEFAULT 'Not applied',
  gumroad_verified_status TEXT NOT NULL DEFAULT 'Pending',
  gumroad_verified_by TEXT,
  gumroad_verified_at TEXT,
  edit_token_hash TEXT NOT NULL,
  registration_source TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(referred_by_participant_id) REFERENCES participants(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gumroad_affiliate_email ON participants(normalized_gumroad_affiliate_email);
CREATE TABLE IF NOT EXISTS referral_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_code TEXT NOT NULL,
  referrer_participant_id INTEGER,
  landing_session_id TEXT,
  converted_to_participant_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS gumroad_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gumroad_purchase_id TEXT NOT NULL UNIQUE,
  gumroad_sale_date TEXT,
  gumroad_product TEXT,
  gumroad_buyer_reference TEXT,
  gumroad_affiliate_email TEXT,
  matched_participant_id INTEGER,
  original_referrer_participant_id INTEGER,
  sale_amount REAL,
  currency TEXT,
  gumroad_affiliate_commission REAL,
  sale_status TEXT,
  refund_status TEXT,
  dispute_status TEXT,
  qualification_status TEXT NOT NULL DEFAULT 'Manual review',
  qualification_reason TEXT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  import_batch_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS referral_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gumroad_sale_id INTEGER NOT NULL UNIQUE,
  referrer_participant_id INTEGER,
  referred_participant_id INTEGER,
  reward_amount REAL NOT NULL,
  reward_currency TEXT NOT NULL DEFAULT 'USD',
  reward_status TEXT NOT NULL DEFAULT 'Pending review',
  approved_by TEXT,
  approved_at TEXT,
  paid_at TEXT,
  payment_reference TEXT,
  reversal_reason TEXT,
  payment_notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(gumroad_sale_id) REFERENCES gumroad_sales(id),
  FOREIGN KEY(referrer_participant_id) REFERENCES participants(id),
  FOREIGN KEY(referred_participant_id) REFERENCES participants(id)
);
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_filename TEXT,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rows_processed INTEGER NOT NULL DEFAULT 0,
  rows_matched INTEGER NOT NULL DEFAULT 0,
  rows_unmatched INTEGER NOT NULL DEFAULT 0,
  qualifying_sales INTEGER NOT NULL DEFAULT 0,
  excluded_sales INTEGER NOT NULL DEFAULT 0,
  duplicate_sales INTEGER NOT NULL DEFAULT 0,
  import_status TEXT NOT NULL DEFAULT 'Preview',
  notes TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  administrator_identity TEXT,
  action TEXT NOT NULL,
  affected_record TEXT,
  previous_value TEXT,
  new_value TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL
);
`);

const MIME = { ".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".avif":"image/avif",".svg":"image/svg+xml",".json":"application/json",".ico":"image/x-icon",".txt":"text/plain; charset=utf-8",".csv":"text/csv; charset=utf-8" };
const GUMROAD_URL = "https://osofnotion.gumroad.com/affiliates";
const REWARD_AMOUNT = Number(process.env.PUMPFIAT_REWARD_AMOUNT || 50);
const adminPassword = process.env.PUMPFIAT_ADMIN_PASSWORD || "";
const configuredSecret = process.env.PUMPFIAT_SESSION_SECRET;
if (!configuredSecret) {
  db.prepare("INSERT OR IGNORE INTO app_settings(setting_key,setting_value) VALUES('session_secret',?)")
    .run(crypto.randomBytes(32).toString("hex"));
}
const sessionSecret = configuredSecret || db.prepare("SELECT setting_value FROM app_settings WHERE setting_key='session_secret'").get().setting_value;
const adminSessions = new Map();
const rateBuckets = new Map();

export function normalizeEmail(value="") { return String(value).trim().toLowerCase(); }
export function generateReferralCode(firstName) {
  const name = String(firstName).toUpperCase().replace(/[^A-Z]/g,"").slice(0,8) || "MEMBER";
  let code;
  do { code = `PF-${name}-${crypto.randomBytes(3).toString("hex").toUpperCase().slice(0,4)}`; }
  while (db.prepare("SELECT 1 FROM participants WHERE referral_code=?").get(code));
  return code;
}

function hashToken(token) { return crypto.createHmac("sha256",sessionSecret).update(token).digest("hex"); }
function randomToken(bytes=24) { return crypto.randomBytes(bytes).toString("hex"); }
function signReferralCode(code) {
  return crypto.createHmac("sha256",sessionSecret).update(`referral:${code}`).digest("hex");
}
function referralCodeFromCookie(value="") {
  const separator=value.lastIndexOf(".");
  if(separator<1)return "";
  const code=value.slice(0,separator),signature=value.slice(separator+1);
  const expected=signReferralCode(code);
  if(signature.length!==expected.length)return "";
  return crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))?code:"";
}
function parseCookies(header="") {
  const decode=(value)=>{try{return decodeURIComponent(value);}catch{return "";}};
  return Object.fromEntries(header.split(";").map(v=>v.trim().split("=")).filter(v=>v[0]).map(([k,...rest])=>[k,decode(rest.join("="))]));
}
function setCookie(res,name,value,opts="HttpOnly; Path=/; SameSite=Lax") {
  const secure=process.env.NODE_ENV==="production"||process.env.PUMPFIAT_COOKIE_SECURE==="true";
  res.setHeader("Set-Cookie",`${name}=${encodeURIComponent(value)}; ${opts}${secure?"; Secure":""}`);
}
function json(res,status,data) {
  const body=JSON.stringify(data);
  res.statusCode=status; res.setHeader("Content-Type","application/json; charset=utf-8"); res.setHeader("Content-Length",Buffer.byteLength(body)); res.end(body);
}
async function body(req,limit=2_000_000) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>limit) throw Object.assign(new Error("Payload too large"),{status:413}); chunks.push(chunk); }
  const text=Buffer.concat(chunks).toString("utf8");
  if(!text) return {};
  const contentType=req.headers["content-type"]||"";
  if(contentType.includes("application/json")) return JSON.parse(text);
  return Object.fromEntries(new URLSearchParams(text));
}
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function audit(admin,action,record,previous="",next="",reason="") {
  db.prepare("INSERT INTO audit_log(administrator_identity,action,affected_record,previous_value,new_value,reason) VALUES(?,?,?,?,?,?)")
    .run(admin||"system",action,record,previous ? JSON.stringify(previous) : null,next ? JSON.stringify(next) : null,reason||null);
}
function adminRequired(req,res) {
  if(!adminPassword) { json(res,503,{error:"Administrator access is not configured"}); return false; }
  const cookies=parseCookies(req.headers.cookie||"");
  const token=cookies.pumpfiat_admin;
  if(!token || !adminSessions.has(token)) { json(res,401,{error:"Unauthorized"}); return false; }
  return true;
}
function registerRateLimit(ip) {
  const now=Date.now(); const entry=rateBuckets.get(ip)||[]; const recent=entry.filter(t=>now-t<60_000);
  recent.push(now); rateBuckets.set(ip,recent); return recent.length<=10;
}

export function parseCSV(text) {
  const rows=[]; let row=[], field="", quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==="\"" ){ if(quoted && text[i+1]==="\""){field+="\"";i++;} else quoted=!quoted; }
    else if(c===","&&!quoted){row.push(field);field="";}
    else if((c==="\n"||c==="\r")&&!quoted){
      if(c==="\r"&&text[i+1]==="\n")i++;
      row.push(field); if(row.some(v=>v.trim()))rows.push(row); row=[];field="";
    } else field+=c;
  }
  row.push(field); if(row.some(v=>v.trim()))rows.push(row);
  if(!rows.length)return {headers:[],records:[]};
  const headers=rows[0].map(v=>v.trim());
  const records=rows.slice(1).map(vals=>Object.fromEntries(headers.map((h,i)=>[h,vals[i]??""])));
  return {headers,records};
}
function inferMapping(headers) {
  const h=headers.map(v=>({raw:v,norm:v.toLowerCase().replace(/[^a-z0-9]/g,"")}));
  const find=(patterns)=>h.find(x=>patterns.some(p=>x.norm.includes(p)))?.raw||"";
  return {
    purchaseId:find(["purchaseid","saleid","orderid","transactionid"]),
    saleDate:find(["saledate","date","createdat"]),
    product:find(["product","item"]),
    affiliateEmail:find(["affiliateemail","affiliatoremail","referreremail"]),
    saleAmount:find(["saleamount","salesamount","amount","price"]),
    currency:find(["currency"]),
    refundStatus:find(["refund","refunded"]),
    disputeStatus:find(["dispute","chargeback"]),
    affiliateCommission:find(["affiliatecommission","commission"])
  };
}
function processRows(records,mapping) {
  let duplicate=0,matched=0,unmatched=0,qualifying=0,excluded=0;
  const preview=[];
  for(const record of records){
    const purchaseId=String(record[mapping.purchaseId]||"").trim();
    const affiliateEmail=normalizeEmail(record[mapping.affiliateEmail]||"");
    if(!purchaseId){preview.push({purchaseId:"",affiliateEmail,status:"Manual review",reason:"Missing purchase ID"});excluded++;continue;}
    const duplicateSale=db.prepare("SELECT id FROM gumroad_sales WHERE gumroad_purchase_id=?").get(purchaseId);
    if(duplicateSale){duplicate++;preview.push({purchaseId,affiliateEmail,status:"Duplicate",reason:"Purchase ID already imported"});continue;}
    const participant=affiliateEmail?db.prepare("SELECT * FROM participants WHERE normalized_gumroad_affiliate_email=?").get(affiliateEmail):null;
    if(!participant){unmatched++;preview.push({purchaseId,affiliateEmail,status:"Unmatched",reason:"Affiliate email not found"});continue;}
    matched++;
    const refund=String(record[mapping.refundStatus]||"").trim().toLowerCase();
    const dispute=String(record[mapping.disputeStatus]||"").trim().toLowerCase();
    const refundFlag=refund && !["no","false","0","not refunded",""].includes(refund);
    const disputeFlag=dispute && !["no","false","0","none",""].includes(dispute);
    let status="Eligible",reason="Direct referrer found";
    if(participant.gumroad_verified_status!=="Approved") {status="Manual review";reason="Affiliate approval not verified";}
    if(!participant.referred_by_participant_id){status="Excluded";reason="Participant has no direct referrer";}
    if(refundFlag){status="Refunded";reason="Sale is refunded or reversed";}
    if(disputeFlag){status="Disputed";reason="Sale has a dispute or chargeback";}
    if(status==="Eligible"){qualifying++;}else{excluded++;}
    preview.push({purchaseId,affiliateEmail,status,reason,participantId:participant.id,referrerId:participant.referred_by_participant_id,record});
  }
  return {total:records.length,duplicate,matched,unmatched,qualifying,excluded,preview};
}

async function handleApi(req,res,url) {
  try {
    if(req.method==="POST"&&url.pathname==="/api/registration/referral"){
      const data=await body(req,100_000);
      const requestedCode=String(data.referralCode||"").trim();
      const cookies=parseCookies(req.headers.cookie||"");
      const consented=cookies.pumpfiat_cookie_choice==="accept";
      const existingCode=consented?referralCodeFromCookie(cookies.pumpfiat_referral||""):"";
      const code=existingCode||requestedCode;
      const ref=code?db.prepare("SELECT id,first_name,last_name,referral_code FROM participants WHERE referral_code=?").get(code):null;
      if(code&&!ref)return json(res,400,{error:"Invalid or expired referral code"});
      if(ref&&consented&&!existingCode){
        const sid=randomToken(16);
        db.prepare("INSERT INTO referral_visits(referral_code,referrer_participant_id,landing_session_id) VALUES(?,?,?)").run(code,ref.id,sid);
        setCookie(res,"pumpfiat_referral",`${code}.${signReferralCode(code)}`,"HttpOnly; Max-Age=2592000; Path=/; SameSite=Lax");
      }
      if(!consented&&cookies.pumpfiat_referral)setCookie(res,"pumpfiat_referral","","HttpOnly; Max-Age=0; Path=/; SameSite=Lax");
      return json(res,200,{valid:!!ref,referrerName:ref?`${ref.first_name} ${ref.last_name}`:""});
    }
    if(req.method==="POST"&&url.pathname==="/api/register"){
      if(!registerRateLimit(req.socket.remoteAddress||"unknown"))return json(res,429,{error:"Too many registration attempts. Please try again later."});
      const data=await body(req,100_000);
      const firstName=String(data.firstName||"").trim(),lastName=String(data.lastName||"").trim(),email=normalizeEmail(data.email||"");
      if(!firstName||!lastName||!validEmail(email))return json(res,400,{error:"First name, last name and a valid email address are required"});
      const cookies=parseCookies(req.headers.cookie||"");
      const acceptedReferralCookie=cookies.pumpfiat_cookie_choice==="accept";
      const code=(acceptedReferralCookie?referralCodeFromCookie(cookies.pumpfiat_referral||""):"")||String(data.referralCode||"").trim();
      let referrer=null;
      if(code){referrer=db.prepare("SELECT * FROM participants WHERE referral_code=?").get(code);if(!referrer)return json(res,400,{error:"Invalid or expired referral code"});}
      if(referrer&&referrer.normalized_registration_email===email)return json(res,400,{error:"You cannot use your own referral link to register"});
      const existing=db.prepare("SELECT * FROM participants WHERE normalized_registration_email=?").get(email);
      if(existing)return json(res,409,{error:"An account with this email already exists. Contact Pumpfiat if you need help accessing your referral details."});
      const referralCode=generateReferralCode(firstName),editToken=randomToken(24);
      db.exec("BEGIN");
      let result;
      try {
        const insert=db.prepare(`INSERT INTO participants(first_name,last_name,registration_email,normalized_registration_email,referral_code,referred_by_participant_id,edit_token_hash,registration_source) VALUES(?,?,?,?,?,?,?,?)`);
        const r=insert.run(firstName,lastName,email,email,referralCode,referrer?.id||null,hashToken(editToken),String(data.registrationSource||"affiliate-page"));
        result=db.prepare("SELECT * FROM participants WHERE id=?").get(Number(r.lastInsertRowid));
        if(referrer)db.prepare("UPDATE referral_visits SET converted_to_participant_id=? WHERE referral_code=? AND converted_to_participant_id IS NULL").run(result.id,code);
        audit("participant", "participant.created", `participant:${result.id}`, null, {registration_email:email,referral_code:referralCode,referred_by_participant_id:referrer?.id||null},"Self-registration or direct referral");
        db.exec("COMMIT");
      } catch(error) {
        db.exec("ROLLBACK");
        throw error;
      }
      setCookie(res,"pumpfiat_referral","","HttpOnly; Max-Age=0; Path=/; SameSite=Lax");
      return json(res,201,{participant:publicParticipant(result),editToken,gumroadUrl:GUMROAD_URL});
    }
    if(req.method==="POST"&&url.pathname.startsWith("/api/participant/")){
      const id=Number(url.pathname.split("/")[3]); const data=await body(req,100_000); const token=String(data.editToken||"");
      const participant=db.prepare("SELECT * FROM participants WHERE id=?").get(id);
      if(!participant||!crypto.timingSafeEqual(Buffer.from(participant.edit_token_hash),Buffer.from(hashToken(token))))return json(res,403,{error:"Invalid participant access"});
      const gumroadEmail=normalizeEmail(data.gumroadAffiliateEmail||"");
      if(gumroadEmail&&!validEmail(gumroadEmail))return json(res,400,{error:"Invalid Gumroad affiliate email"});
      const allowed=["Not applied","Application submitted","Approved","Rejected","Needs review"];
      const reported=allowed.includes(data.reportedStatus)?data.reportedStatus:"Not applied";
      const duplicate=gumroadEmail?db.prepare("SELECT id FROM participants WHERE normalized_gumroad_affiliate_email=? AND id<>?").get(gumroadEmail,id):null;
      if(duplicate)return json(res,409,{error:"That Gumroad affiliate email is already assigned"});
      db.prepare("UPDATE participants SET gumroad_affiliate_email=?,normalized_gumroad_affiliate_email=?,gumroad_profile_url=?,gumroad_reported_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(gumroadEmail||null,gumroadEmail||null,String(data.profileUrl||"").trim()||null,reported,id);
      audit("participant", "gumroad.details.updated", `participant:${id}`, null, {gumroad_affiliate_email:gumroadEmail,reported_status:reported},"Participant update");
      return json(res,200,{success:true});
    }
    if(url.pathname==="/api/config"){
      return json(res,200,{gumroadUrl:GUMROAD_URL,rewardAmount:REWARD_AMOUNT,rewardCurrency:"USD"});
    }
    if(url.pathname.startsWith("/api/admin/")){
      if(req.method==="POST"&&url.pathname==="/api/admin/login"){
        const data=await body(req,100_000);
        if(!adminPassword||data.password!==adminPassword)return json(res,401,{error:"Invalid credentials"});
        const token=randomToken(32);adminSessions.set(token,Date.now());
        setCookie(res,"pumpfiat_admin",token,"HttpOnly; Max-Age=28800; Path=/; SameSite=Strict");
        return json(res,200,{success:true});
      }
      if(req.method==="POST"&&url.pathname==="/api/admin/logout"){const cookies=parseCookies(req.headers.cookie||"");adminSessions.delete(cookies.pumpfiat_admin);setCookie(res,"pumpfiat_admin","","HttpOnly; Max-Age=0; Path=/; SameSite=Strict");return json(res,200,{success:true});}
      if(!adminRequired(req,res))return;
      if(url.pathname==="/api/admin/me")return json(res,200,{authenticated:true});
      if(url.pathname==="/api/admin/summary"){
        const count=(sql,args=[])=>db.prepare(sql).get(...args)?.count||0;
        return json(res,200,{
          participants:count("SELECT COUNT(*) count FROM participants"),
          referralRegistrations:count("SELECT COUNT(*) count FROM participants WHERE referred_by_participant_id IS NOT NULL"),
          gumroadApproved:count("SELECT COUNT(*) count FROM participants WHERE gumroad_verified_status='Approved'"),
          awaitingApproval:count("SELECT COUNT(*) count FROM participants WHERE gumroad_verified_status='Pending'"),
          sales:count("SELECT COUNT(*) count FROM gumroad_sales"),
          matchedSales:count("SELECT COUNT(*) count FROM gumroad_sales WHERE matched_participant_id IS NOT NULL"),
          unmatchedSales:count("SELECT COUNT(*) count FROM gumroad_sales WHERE matched_participant_id IS NULL"),
          qualifyingSales:count("SELECT COUNT(*) count FROM gumroad_sales WHERE qualification_status='Eligible'"),
          pendingRewards:count("SELECT COUNT(*) count FROM referral_rewards WHERE reward_status='Pending review'"),
          approvedRewards:count("SELECT COUNT(*) count FROM referral_rewards WHERE reward_status='Approved'"),
          paidRewards:count("SELECT COUNT(*) count FROM referral_rewards WHERE reward_status='Paid'")
        });
      }
      if(url.pathname==="/api/admin/participants"){
        const search=normalizeEmail(url.searchParams.get("search")||"").toLowerCase();
        let sql=`SELECT p.*, r.first_name||' '||r.last_name AS referrer_name,
          (SELECT COUNT(*) FROM participants c WHERE c.referred_by_participant_id=p.id) direct_referrals,
          (SELECT COUNT(*) FROM gumroad_sales s WHERE s.matched_participant_id=p.id AND s.qualification_status='Eligible') qualifying_sales,
          (SELECT COALESCE(SUM(rw.reward_amount),0) FROM referral_rewards rw WHERE rw.referred_participant_id=p.id) own_referrer_rewards
          FROM participants p LEFT JOIN participants r ON r.id=p.referred_by_participant_id`;
        const params=[];
        if(search){sql+=" WHERE lower(p.first_name||' '||p.last_name) LIKE ? OR lower(p.normalized_registration_email) LIKE ? OR lower(p.referral_code) LIKE ?";params.push(`%${search}%`,`%${search}%`,`%${search}%`);}
        sql+=" ORDER BY p.created_at DESC LIMIT 500";
        return json(res,200,{participants:db.prepare(sql).all(...params)});
      }
      if(url.pathname.startsWith("/api/admin/participant/")&&req.method==="GET"){
        const id=Number(url.pathname.split("/").pop()); const p=db.prepare("SELECT * FROM participants WHERE id=?").get(id);
        if(!p)return json(res,404,{error:"Participant not found"});
        const direct=db.prepare("SELECT id,first_name,last_name,referral_code,created_at FROM participants WHERE referred_by_participant_id=?").all(id);
        const sales=db.prepare("SELECT * FROM gumroad_sales WHERE matched_participant_id=? ORDER BY gumroad_sale_date DESC").all(id);
        const rewards=db.prepare("SELECT rw.*,p.first_name||' '||p.last_name AS referred_name,s.gumroad_purchase_id FROM referral_rewards rw LEFT JOIN participants p ON p.id=rw.referred_participant_id LEFT JOIN gumroad_sales s ON s.id=rw.gumroad_sale_id WHERE rw.referrer_participant_id=?").all(id);
        return json(res,200,{participant:p,direct,sales,rewards});
      }
      if(url.pathname.startsWith("/api/admin/participant/")&&req.method==="PATCH"){
        const id=Number(url.pathname.split("/").pop()); const data=await body(req,100_000);
        const p=db.prepare("SELECT * FROM participants WHERE id=?").get(id);if(!p)return json(res,404,{error:"Participant not found"});
        const gumroadEmail=normalizeEmail(data.gumroadAffiliateEmail||p.normalized_gumroad_affiliate_email||"");
        const status=["Pending","Approved","Rejected","Needs review"].includes(data.verifiedStatus)?data.verifiedStatus:p.gumroad_verified_status;
        if(gumroadEmail&&(!validEmail(gumroadEmail)||db.prepare("SELECT id FROM participants WHERE normalized_gumroad_affiliate_email=? AND id<>?").get(gumroadEmail,id)))return json(res,400,{error:"Invalid or duplicate Gumroad affiliate email"});
        db.prepare("UPDATE participants SET gumroad_affiliate_email=?,normalized_gumroad_affiliate_email=?,gumroad_verified_status=?,gumroad_verified_by=?,gumroad_verified_at=?,gumroad_profile_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(gumroadEmail||null,gumroadEmail||null,status,status==="Approved"?"admin":null,status==="Approved"?new Date().toISOString():null,String(data.profileUrl||p.gumroad_profile_url||"").trim()||null,id);
        audit("admin", "participant.gumroad.updated", `participant:${id}`, {gumroad_affiliate_email:p.normalized_gumroad_affiliate_email,verified_status:p.gumroad_verified_status}, {gumroad_affiliate_email:gumroadEmail,verified_status:status},String(data.reason||""));
        return json(res,200,{success:true});
      }
      if(url.pathname==="/api/admin/import/preview"&&req.method==="POST"){
        const data=await body(req,5_000_000);const parsed=parseCSV(String(data.csv||""));
        if(!parsed.headers.length)return json(res,400,{error:"CSV contains no headers"});
        const mapping={...inferMapping(parsed.headers),...(data.mapping||{})};
        return json(res,200,{headers:parsed.headers,mapping,preview:processRows(parsed.records,mapping)});
      }
      if(url.pathname==="/api/admin/import/confirm"&&req.method==="POST"){
        const data=await body(req,5_000_000);const parsed=parseCSV(String(data.csv||""));const mapping={...inferMapping(parsed.headers),...(data.mapping||{})};
        if(!mapping.purchaseId||!mapping.affiliateEmail)return json(res,400,{error:"Purchase ID and affiliate email mapping are required"});
        const batch=db.prepare("INSERT INTO import_batches(original_filename,uploaded_by,rows_processed,import_status) VALUES(?,?,?,?)").run(String(data.filename||"gumroad-sales.csv"),"admin",parsed.records.length,"Processing");
        const batchId=Number(batch.lastInsertRowid);
        const summary={rowsProcessed:parsed.records.length,matched:0,unmatched:0,qualifying:0,excluded:0,duplicates:0};
        db.exec("BEGIN");
        try {
          for(const record of parsed.records){
            const purchaseId=String(record[mapping.purchaseId]||"").trim();if(!purchaseId)continue;
            if(db.prepare("SELECT id FROM gumroad_sales WHERE gumroad_purchase_id=?").get(purchaseId)){summary.duplicates++;continue;}
            const affiliateEmail=normalizeEmail(record[mapping.affiliateEmail]||"");
            const participant=affiliateEmail?db.prepare("SELECT * FROM participants WHERE normalized_gumroad_affiliate_email=?").get(affiliateEmail):null;
            if(!participant){summary.unmatched++;continue;}
            summary.matched++;
            const refund=String(record[mapping.refundStatus]?record[mapping.refundStatus]: "").toLowerCase().trim();
            const dispute=String(record[mapping.disputeStatus]?record[mapping.disputeStatus]: "").toLowerCase().trim();
            const refundFlag=refund&&!["no","false","0","not refunded",""].includes(refund);
            const disputeFlag=dispute&&!["no","false","0","none",""].includes(dispute);
            let qualification="Manual review",reason="Affiliate sale requires review";
            if(participant.gumroad_verified_status==="Approved"&&!refundFlag&&!disputeFlag&&participant.referred_by_participant_id){qualification="Eligible";reason="Verified affiliate, direct referrer, no refund or dispute";}
            else if(!participant.referred_by_participant_id){qualification="Excluded";reason="Participant has no direct referrer";}
            else if(refundFlag){qualification="Refunded";reason="Sale is refunded or reversed";}
            else if(disputeFlag){qualification="Disputed";reason="Sale has a dispute or chargeback";}
            else if(participant.gumroad_verified_status!=="Approved"){qualification="Manual review";reason="Affiliate approval not verified";}
            if(qualification==="Eligible")summary.qualifying++;else summary.excluded++;
            const result=db.prepare(`INSERT INTO gumroad_sales(gumroad_purchase_id,gumroad_sale_date,gumroad_product,gumroad_affiliate_email,matched_participant_id,original_referrer_participant_id,sale_amount,currency,gumroad_affiliate_commission,refund_status,dispute_status,qualification_status,qualification_reason,import_batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .run(purchaseId,record[mapping.saleDate]||null,record[mapping.product]||null,affiliateEmail,participant.id,participant.referred_by_participant_id||null,Number(String(record[mapping.saleAmount]||"").replace(/[^0-9.-]/g,""))||null,record[mapping.currency]||null,Number(String(record[mapping.affiliateCommission]||"").replace(/[^0-9.-]/g,""))||null,record[mapping.refundStatus]||null,record[mapping.disputeStatus]||null,qualification,reason,batchId);
            if(qualification==="Eligible"){
              db.prepare("INSERT INTO referral_rewards(gumroad_sale_id,referrer_participant_id,referred_participant_id,reward_amount,reward_currency,reward_status) VALUES(?,?,?,?,?,?)")
                .run(Number(result.lastInsertRowid),participant.referred_by_participant_id,participant.id,REWARD_AMOUNT,"USD","Pending review");
            }
          }
          db.exec("COMMIT");
        } catch(error) {
          db.exec("ROLLBACK");
          throw error;
        }
        db.prepare("UPDATE import_batches SET rows_processed=?,rows_matched=?,rows_unmatched=?,qualifying_sales=?,excluded_sales=?,duplicate_sales=?,import_status=? WHERE id=?")
          .run(summary.rowsProcessed,summary.matched,summary.unmatched,summary.qualifying,summary.excluded,summary.duplicates,"Completed",batchId);
        audit("admin","gumroad.import.completed",`import_batch:${batchId}`,null,summary,String(data.reason||""));
        return json(res,200,{batchId,...summary});
      }
      if(url.pathname==="/api/admin/rewards"){
        const status=url.searchParams.get("status");
        let sql=`SELECT rw.*,rp.first_name||' '||rp.last_name AS referrer_name,p.first_name||' '||p.last_name AS referred_name,s.gumroad_purchase_id,s.gumroad_sale_date FROM referral_rewards rw LEFT JOIN participants rp ON rp.id=rw.referrer_participant_id LEFT JOIN participants p ON p.id=rw.referred_participant_id LEFT JOIN gumroad_sales s ON s.id=rw.gumroad_sale_id`;
        const params=[];
        if(status){sql+=" WHERE rw.reward_status=?";params.push(status);}
        sql+=" ORDER BY rw.created_at DESC";
        return json(res,200,{rewards:db.prepare(sql).all(...params)});
      }
      if(url.pathname.startsWith("/api/admin/reward/")&&req.method==="PATCH"){
        const id=Number(url.pathname.split("/").pop());const data=await body(req,100_000);const reward=db.prepare("SELECT * FROM referral_rewards WHERE id=?").get(id);if(!reward)return json(res,404,{error:"Reward not found"});
        const status=data.status;if(!["Pending review","Approved","Paid","Reversed","Rejected"].includes(status))return json(res,400,{error:"Invalid reward status"});
        db.prepare("UPDATE referral_rewards SET reward_status=?,approved_by=?,approved_at=?,paid_at=?,payment_reference=?,reversal_reason=?,payment_notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(status,status==="Approved"? "admin":reward.approved_by,status==="Approved"?new Date().toISOString():reward.approved_at,status==="Paid"?String(data.paidAt||new Date().toISOString()):reward.paid_at,status==="Paid"?String(data.paymentReference||""):reward.payment_reference,status==="Reversed"?String(data.reason||""):reward.reversal_reason,String(data.paymentNotes||reward.payment_notes||"")||null,id);
        audit("admin",`reward.${status.toLowerCase().replace(/ /g,".")}`,`reward:${id}`,{status:reward.reward_status},{status,payment_reference:data.paymentReference||null},String(data.reason||""));
        return json(res,200,{success:true});
      }
      if(url.pathname==="/api/admin/audit"){
        return json(res,200,{events:db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500").all()});
      }
      return json(res,404,{error:"Not found"});
    }
    return json(res,404,{error:"Not found"});
  } catch(error) {
    if(error instanceof SyntaxError)return json(res,400,{error:"Invalid JSON"});
    return json(res,error.status||500,{error:error.message||"Server error"});
  }
}

function publicParticipant(p) {
  const base=process.env.PUMPFIAT_PUBLIC_URL||"";
  const url=base?`${base.replace(/\/$/,"")}/opportunities/osof-no-code-affiliate-campaign/?ref=${encodeURIComponent(p.referral_code)}`:`/opportunities/osof-no-code-affiliate-campaign/?ref=${encodeURIComponent(p.referral_code)}`;
  return {id:p.id,firstName:p.first_name,lastName:p.last_name,referralCode:p.referral_code,referralUrl:url,gumroadAffiliateEmail:p.normalized_gumroad_affiliate_email,gumroadReportedStatus:p.gumroad_reported_status,gumroadVerifiedStatus:p.gumroad_verified_status};
}

function safeStaticPath(urlPath) {
  let decoded;
  try{decoded=decodeURIComponent(urlPath)}catch{return null}
  const requested=decoded==="/"?"/index.html":decoded;
  const candidate=path.resolve(PUBLIC_ROOT,`.${requested}`);
  if(candidate!==PUBLIC_ROOT&&!candidate.startsWith(PUBLIC_ROOT+path.sep))return null;
  return candidate;
}

export async function createServer() {
  return http.createServer(async(req,res)=>{
    const url=new URL(req.url,`http://${req.headers.host||"localhost"}`);
    if(url.pathname.startsWith("/api/"))return handleApi(req,res,url);
    let file=safeStaticPath(url.pathname);
    if(file&&fs.statSync(file,{throwIfNoEntry:false})?.isDirectory())file=path.join(file,"index.html");
    if(url.pathname.startsWith("/admin")){
      file=path.join(PUBLIC_ROOT,"admin","index.html");
    }
    if(!file||!fs.statSync(file,{throwIfNoEntry:false})?.isFile()){
      file=path.join(PUBLIC_ROOT,"404.html");
      res.statusCode=404;
    }
    if(!fs.statSync(file,{throwIfNoEntry:false})?.isFile()){res.statusCode=404;res.setHeader("Content-Type","text/plain; charset=utf-8");res.end("Not found");return;}
    res.setHeader("Content-Type",MIME[path.extname(file).toLowerCase()]||"application/octet-stream");
    fs.createReadStream(file).pipe(res);
  });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||process.env.PUMPFIAT_PORT||4174);
  await buildSite();
  createServer().then(server=>server.listen(port,"0.0.0.0",()=>console.log(`Pumpfiat server listening on http://0.0.0.0:${port}`)));
}
