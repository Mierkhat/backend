import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['test/**/*.integration.ts'],testTimeout:30000,hookTimeout:60000,fileParallelism:false}});
