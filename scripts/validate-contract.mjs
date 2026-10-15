import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const spec=JSON.parse(readFileSync(new URL('../contracts/client.openapi.json',import.meta.url)));
const resolve=ref=>ref.slice(2).split('/').reduce((x,key)=>x?.[key],spec);
const scan=x=>{if(!x||typeof x!=='object')return;for(const [key,value]of Object.entries(x)){if(key==='$ref')assert.ok(resolve(value),`Unresolved ${value}`);else scan(value)}};scan(spec);
// A security requirement names a scheme of components.securitySchemes, or a client generator fails on it and Swagger UI shows no padlock.
const schemes=new Set(Object.keys(spec.components.securitySchemes??{}));
for(const [path,item]of Object.entries(spec.paths))for(const [method,op]of Object.entries(item))for(const requirement of op?.security??[])for(const scheme of Object.keys(requirement))assert.ok(schemes.has(scheme),`${method.toUpperCase()} ${path} requires the undeclared security scheme ${scheme}`);
const name=spec.info.title;if(name.includes('sdk')){const item=spec.paths['/_mdrn/v1/database/collections/{collection}/records/{recordId}'];assert.ok(item.patch);assert.equal(item.put,undefined);assert.equal(spec.paths['/v1/storage/data'],undefined)}
if(name.includes('mcp')){assert.ok(spec.paths['/v1/platform/operations/{operationId}']);for(const item of Object.values(spec.paths))for(const method of ['post','put','patch','delete'])assert.equal(item[method],undefined)}
// The CLI's snapshot holds only what its commands call: never a console-only route.
if(name.includes('cli')){assert.ok(Object.keys(spec.paths).length>40);for(const path of Object.keys(spec.paths))assert.ok(!/login|csrf|session|webhooks|console|(?<!mail\/)callback/.test(path),`${path} is a console route the CLI never calls`)}
console.log('Contract references and client operation bounds verified');
