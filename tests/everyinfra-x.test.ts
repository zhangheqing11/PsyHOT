import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { everyInfraXCandidate } from "@aihot/backend/sources/everyinfra-x";
import { collectSource, adaptIntervals } from "@aihot/backend/sources/collect";
import { discoverWechatAccounts } from "@aihot/backend/providers/everyinfra";
import { stopBoss } from "@aihot/backend/jobs/queue";
const T=tag();
const row={id:String(BigInt(Date.now())*1000n),url:"",text:"New psychology research on AI and mental health",author_name:"Researcher",posted_at:new Date().toISOString(),like_count:12,retweet_count:3};
row.url=`https://twitter.com/research/status/${row.id}?s=20`;
const calls:Array<any>=[];
const provider=await stub((_n,req)=>{const call=JSON.parse(req.body);calls.push(call); return {id:`req-${T}-${calls.length}`,billing:{charged_usd:0.000556},results:call.action==='account_search'?[{ghid:'gh_candidate',name:'研究候选'}]:[row,{...row,id:123}]};});
process.env.EVERYINFRA_BASE_URL=provider.url;process.env.EVERYINFRA_API_KEY="test-key";config.allowPrivateNetworkFetch=true;
after(async()=>{await provider.close();await stopBoss();await closeDb();});

test("X discovery maps stable post identities and rejects unsafe URLs or imprecise IDs",()=>{
 const c=everyInfraXCandidate(row)!;assert.equal(c.identityKey,`x:${row.id}`);assert.equal(c.url,`https://x.com/research/status/${row.id}`);assert.equal(c.bodyText,row.text);assert.equal(c.xPost!.handle,'research');
 for(const patch of [{id:123},{url:'https://evil.test/research/status/'+row.id},{url:'http://x.com/research/status/'+row.id},{url:'https://x.com/research/status/999'}]) assert.equal(everyInfraXCandidate({...row,...patch}),null);
});

test("X search calls twitter through receipts, imports once and keeps its paid interval",async()=>{
 const id=`test-eix-${T}`;const sourceConfig={adapter:'everyinfra_x',everyinfraAction:'search',everyinfraParams:{keyword:`psychology ${T}`}};
 await sql`INSERT INTO sources(id,name,kind,config,participation_mode,interval_minutes) VALUES(${id},'X test','json_list',${sql.json(sourceConfig)},'hot_signal',360)`;
 const source={id,config:sourceConfig,cursor:null};
 const candidates=await fetchJsonList(source as never);assert.equal(candidates.length,1);
 assert.equal((await collectSource(id)).created,1);assert.equal((await collectSource(id)).created,0);
 assert.equal(calls.filter(x=>x.platform==='twitter').length,1,'same window reuses the listing');
 const [receipt]=await sql`SELECT cost FROM receipts WHERE subject=${id}`;assert.equal(Number(receipt!.cost),0.000556);
 await adaptIntervals();const [saved]=await sql`SELECT interval_minutes FROM sources WHERE id=${id}`;assert.equal(saved!.interval_minutes,360);
 const [article]=await sql`SELECT id,x_post FROM articles WHERE source_id=${id}`;assert.equal(article!.x_post.tweetId,row.id);
 assert.ok((await sql`SELECT 1 FROM pgboss.job WHERE name='events.group' AND data->>'articleId'=${article!.id}`).length>0);
});

test("WeChat discovery only returns candidates; it never registers them or downloads bodies",async()=>{
 const before=Number((await sql`SELECT count(*) n FROM sources`)[0]!.n);
 const got=await discoverWechatAccounts(`AI心理健康 ${T}`,'test');assert.equal(got.results.length,1);
 assert.equal(calls.at(-1).action,'account_search');assert.equal(Number((await sql`SELECT count(*) n FROM sources`)[0]!.n),before);
 assert.ok(!calls.some(c=>['account_articles','article_detail'].includes(c.action)));
});
