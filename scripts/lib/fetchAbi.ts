import 'dotenv/config';
import fetch from 'node-fetch';

export async function getAbiFromArbiscan(address: string): Promise<any> {
  const apiKey = process.env.ARBISCAN_API_KEY || '';
  const url = `https://api.arbiscan.io/api?module=contract&action=getabi&address=${address}&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Arbiscan HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== '1') throw new Error(`Arbiscan error: ${j.result}`);
  return JSON.parse(j.result);
}
