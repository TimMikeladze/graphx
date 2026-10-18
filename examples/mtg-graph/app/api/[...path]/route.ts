import { app } from '@/src/api';
export const dynamic = 'force-dynamic';
const handler = (request: Request) => app.fetch(request);
export { handler as GET, handler as POST, handler as PUT, handler as DELETE, handler as OPTIONS };
