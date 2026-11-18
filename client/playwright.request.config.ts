import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/e2e',testMatch:'**/request-qr.spec.ts',workers:1,timeout:30000,
  use:{baseURL:'http://127.0.0.1:1432',trace:'off',screenshot:'off',video:'off'},
  reporter:'list',
  globalSetup:'./tests/request-global.ts',
  projects:[
    {name:'1280-light',use:{browserName:'chromium',viewport:{width:1280,height:900},colorScheme:'light'}},
    {name:'1280-dark',use:{browserName:'chromium',viewport:{width:1280,height:900},colorScheme:'dark'}},
    {name:'390-light',use:{browserName:'chromium',viewport:{width:390,height:844},colorScheme:'light',isMobile:true,hasTouch:true}},
    {name:'390-dark',use:{browserName:'chromium',viewport:{width:390,height:844},colorScheme:'dark',isMobile:true,hasTouch:true}},
  ],
});
