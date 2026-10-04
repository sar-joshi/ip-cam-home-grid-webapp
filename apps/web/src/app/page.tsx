import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { gateway, gatewayConfigured } from '@/lib/gateway';
import { Viewer } from '@/components/viewer';
import { camerasSchema, preferencesSchema } from '@homegrid/shared';
import { GatewayOffline } from '@/components/gateway-offline';
export const dynamic = 'force-dynamic';
export default async function Page() {
  if (!gatewayConfigured()) redirect('/login');
  let response: Response;
  try {response = await gateway('/internal/bootstrap', {headers: {cookie: (await headers()).get('cookie') ?? ''}});}
  catch {return <GatewayOffline />;}
  if (response.status === 401) redirect('/login');
  if (!response.ok) return <GatewayOffline />;
  const data = await response.json();
  const cameras = camerasSchema.parse(data.cameras);
  const preferences = preferencesSchema.parse(data.preferences);
  return <Viewer cameras={cameras} initialPreferences={preferences} />;
}
