import dotenv from 'dotenv';
import { Bot } from './bot';
import { Database } from './db';

dotenv.config();

const db = await Database.connect();
const bot = new Bot(db)
await bot.start();