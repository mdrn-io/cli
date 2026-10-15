// The CLI's snapshot of the shared contract: exactly the operations its commands call, so the
// snapshot never describes a console-only route (login, CSRF, session, webhooks). Each entry is
// a path and the methods the CLI sends to it; test/contract.test.js checks every README example
// against the snapshot, and validate-contract.mjs that no console route slipped in.
//   node scripts/sync-contract.mjs [--check] ../docs/site/mdrn-mvp.openapi.json
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const check=process.argv.includes('--check');const source=process.argv.slice(2).find(a=>a!=='--check');if(!source)throw Error('Usage: node scripts/sync-contract.mjs [--check] ../docs/site/mdrn-mvp.openapi.json');
const spec=JSON.parse(readFileSync(source,'utf8'));
const root=resolve(new URL('..',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const CLI_PATHS={
 // login, logout, whoami (src/auth.js, src/session.js)
 '/.well-known/oauth-authorization-server':['get'],
 '/oauth/token':['post'],
 '/oauth/revoke':['post'],
 '/v1/platform/oauth/token-info':['get'],
 '/v1/platform/me':['get'],
 // workspaces, projects, products, identity, mail, usage, billing, operations, tokens (src/client.js)
 '/v1/platform/workspaces':['get'],
 '/v1/platform/projects':['get','post'],
 '/v1/platform/projects/{projectId}/environments/{environmentId}/products':['get'],
 '/v1/platform/projects/{projectId}/environments/{environmentId}/products/{product}/enable':['post'],
 '/v1/platform/projects/{projectId}/environments/{environmentId}/products/{product}/disable':['post'],
 '/v1/platform/projects/{projectId}/environments/{environmentId}/products/{product}/delete':['post'],
 '/v1/platform/projects/{projectId}/environments/{environmentId}/products/{product}/restore':['post'],
 '/v1/platform/projects/{projectId}/environments/{environmentId}/identity/origins':['get'],
 '/v1/platform/identity/activations':['post'],
 '/v1/platform/projects/{projectId}/environments/{environmentId}/mail/templates':['post'],
 '/v1/platform/projects/{projectId}/environments/{environmentId}/mail/callback':['post'],
 '/v1/platform/projects/{projectId}/environments/{environmentId}/mail/suppressions':['post'],
 '/v1/platform/usage':['get'],
 '/v1/platform/workspaces/{workspaceId}/billing':['get'],
 '/v1/platform/workspaces/{workspaceId}/billing/checkout':['post'],
 '/v1/platform/workspaces/{workspaceId}/billing/portal':['post'],
 '/v1/platform/operations/{operationId}':['get'],
 '/v1/platform/workspaces/{workspaceId}/tokens':['get'],
 '/v1/platform/tokens/{tokenId}':['delete'],
 // deploy, rollback, builds, releases, deployments, services, github, variables, domains, logs (src/client.js, src/deploy.js, src/link.js)
 '/v1/deploy/services':['get','post'],
 '/v1/deploy/services/{serviceId}/enable':['post'],
 '/v1/deploy/services/{serviceId}/disable':['post'],
 '/v1/deploy/services/{serviceId}/github':['put'],
 '/v1/deploy/services/{serviceId}/variables':['get'],
 '/v1/deploy/services/{serviceId}/variables/{name}':['put','delete'],
 '/v1/deploy/uploads':['post'],
 '/v1/deploy/uploads/{uploadId}/content':['put'],
 '/v1/deploy/uploads/{uploadId}/complete':['post'],
 '/v1/deploy/builds':['get','post'],
 '/v1/deploy/builds/{buildId}':['get'],
 '/v1/deploy/builds/{buildId}/logs':['get'],
 '/v1/deploy/builds/{buildId}/cancel':['post'],
 '/v1/deploy/releases':['get'],
 '/v1/deploy/deployments':['get','post'],
 '/v1/deploy/deployments/{deploymentId}':['get'],
 '/v1/deploy/deployments/{deploymentId}/cancel':['post'],
 '/v1/deploy/github/installations':['get'],
 '/v1/deploy/github/repositories':['get'],
 '/v1/deploy/domains':['get','post'],
 '/v1/deploy/domains/{domainId}':['get','patch','delete'],
 '/v1/deploy/domains/{domainId}/verify':['post'],
 '/v1/deploy/logs':['get'],
 '/v1/deploy/logs/trace/{traceId}':['get'],
};
const paths={};const absent=[];
for(const [path,methods] of Object.entries(CLI_PATHS)){
 const item=spec.paths[path];if(!item){absent.push(path);continue;}
 const kept={};for(const key of ['summary','description','parameters'])if(item[key]!==undefined)kept[key]=item[key];
 for(const method of methods){if(!item[method])throw Error(`${source} has no ${method.toUpperCase()} ${path}`);kept[method]=item[method];}
 paths[path]=kept;
}
// A route the canonical contract does not describe yet is left out of the snapshot, and said.
if(absent.length)console.error(`cli: not in ${source}, left out of the snapshot: ${absent.join(', ')}`);
const out={openapi:spec.openapi,info:{title:'MDRN cli contract snapshot',version:spec.info.version,description:'The operations the CLI\'s commands call, from the canonical shared contract. mdrn request reaches any management route; this snapshot describes the named commands.'},servers:spec.servers,paths,components:{securitySchemes:spec.components.securitySchemes,schemas:{}}};
const pending=[];const scan=x=>{if(!x||typeof x!=='object')return;for(const [k,v]of Object.entries(x)){if(k==='$ref'&&typeof v==='string'&&v.startsWith('#/components/schemas/'))pending.push(v.split('/').at(-1));else scan(v)}};scan(paths);
while(pending.length){const name=pending.pop();if(out.components.schemas[name])continue;const schema=spec.components.schemas[name];if(!schema)throw Error(`Missing schema ${name}`);out.components.schemas[name]=schema;scan(schema)}
const target=resolve(root,'contracts/client.openapi.json');const text=JSON.stringify(out,null,2)+'\n';
if(check){const current=existsSync(target)?readFileSync(target,'utf8').replace(/\r\n/g,'\n'):'';if(current!==text){console.error('cli: contracts/client.openapi.json is stale; rerun this command without --check');process.exit(1)}console.log('cli: contract snapshot is current');process.exit(0)}
mkdirSync(resolve(root,'contracts'),{recursive:true});writeFileSync(target,text);console.log(`cli: ${Object.keys(paths).length} route families synchronized`);
