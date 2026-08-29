import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/server/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.LATEDEV_DB_URL ?? ':memory:',
  },
  strict: true,
  verbose: true,
});
