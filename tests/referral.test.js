import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PUMPFIAT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(),"pumpfiat-test-"));
process.env.PUMPFIAT_ADMIN_PASSWORD = "test-admin-password";
process.env.PUMPFIAT_SESSION_SECRET = "test-session-secret";

const { createServer, normalizeEmail, parseCSV } = await import("../server.js");

async function request(server,path,options={}) {
  const address=server.address();
  const response=await fetch(`http://127.0.0.1:${address.port}${path}`,options);
  const text=await response.text();
  let data=null;
  try{data=JSON.parse(text)}catch{data=text}
  return {response,data};
}

test("referral attribution is first-touch and ignores client-supplied replacement codes",async()=>{
  const server=await createServer();await new Promise(r=>server.listen(0,"127.0.0.1",r));
  try{
    let result=await request(server,"/api/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({firstName:"Sarah",lastName:"One",email:"Sarah@example.com"})});
    assert.equal(result.response.status,201,JSON.stringify(result.data));
    const sarah=result.data.participant;assert.ok(sarah.referralCode.startsWith("PF-SARAH-"));

    result=await request(server,"/api/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({firstName:"Amy",lastName:"Other",email:"Amy@example.com"})});
    assert.equal(result.response.status,201);
    const amy=result.data.participant;

    const consentCookie="pumpfiat_cookie_choice=accept";
    result=await request(server,"/api/registration/referral",{method:"POST",headers:{"Content-Type":"application/json","Cookie":consentCookie},body:JSON.stringify({referralCode:sarah.referralCode})});
    assert.equal(result.response.status,200);
    const firstTouchCookie=result.response.headers.get("set-cookie").split(";")[0];
    assert.ok(firstTouchCookie.includes("."));
    const acceptedCookies=`${consentCookie}; ${firstTouchCookie}`;

    result=await request(server,"/api/register",{method:"POST",headers:{"Content-Type":"application/json","Cookie":acceptedCookies},body:JSON.stringify({firstName:"Sarah",lastName:"One",email:"sarah@example.com"})});
    assert.equal(result.response.status,400);

    result=await request(server,"/api/registration/referral",{method:"POST",headers:{"Content-Type":"application/json","Cookie":acceptedCookies},body:JSON.stringify({referralCode:amy.referralCode})});
    assert.equal(result.data.referrerName,"Sarah One");
    assert.equal(result.response.headers.get("set-cookie"),null);

    result=await request(server,"/api/register",{method:"POST",headers:{"Content-Type":"application/json","Cookie":acceptedCookies},body:JSON.stringify({firstName:"John",lastName:"Two",email:"John@example.com",referralCode:amy.referralCode})});
    assert.equal(result.response.status,201);
    const johnRegistration=result.data;

    result=await request(server,"/api/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({firstName:"John",lastName:"Duplicate",email:"JOHN@example.com"})});
    assert.equal(result.response.status,409);

    result=await request(server,`/api/participant/${johnRegistration.participant.id}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({editToken:johnRegistration.editToken,gumroadAffiliateEmail:"john.aff@example.com",reportedStatus:"Application submitted"})});
    assert.equal(result.response.status,200);

    const login=await request(server,"/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:"test-admin-password"})});
    const adminCookie=login.response.headers.get("set-cookie").split(";")[0];
    const participants=await request(server,"/api/admin/participants",{headers:{"Cookie":adminCookie}});
    const john=participants.data.participants.find(p=>p.normalized_registration_email==="john@example.com");
    assert.equal(john.referrer_name,"Sarah One");
  }finally{await new Promise(r=>server.close(r));}
});

test("referral attribution works without storing an optional referral cookie",async()=>{
  const server=await createServer();await new Promise(r=>server.listen(0,"127.0.0.1",r));
  try{
    const referrer=await request(server,"/api/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({firstName:"Mina",lastName:"Referrer",email:"mina.referrer@example.com"})});
    assert.equal(referrer.response.status,201);
    const lookup=await request(server,"/api/registration/referral",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({referralCode:referrer.data.participant.referralCode})});
    assert.equal(lookup.data.valid,true);
    assert.equal(lookup.response.headers.get("set-cookie"),null);

    const registration=await request(server,"/api/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({firstName:"Noah",lastName:"Direct",email:"noah.direct@example.com",referralCode:referrer.data.participant.referralCode})});
    assert.equal(registration.response.status,201);
  }finally{await new Promise(r=>server.close(r));}
});

test("invalid referral codes are rejected",async()=>{
  const server=await createServer();await new Promise(r=>server.listen(0,"127.0.0.1",r));
  try{
    const result=await request(server,"/api/registration/referral",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({referralCode:"PF-NOT-REAL"})});
    assert.equal(result.response.status,400);
  }finally{await new Promise(r=>server.close(r));}
});

test("CSV parser and email normalization",()=>{
  const parsed=parseCSV("Purchase ID,Affiliate Email,Refund Status\nABC-1,Affiliate@example.com,No");
  assert.equal(parsed.headers[1],"Affiliate Email");
  assert.equal(parsed.records[0]["Affiliate Email"],"Affiliate@example.com");
  assert.equal(normalizeEmail(" Affiliate@Example.com "), "affiliate@example.com");
});
