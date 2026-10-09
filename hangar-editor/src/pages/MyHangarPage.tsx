import { useMe } from '../auth/AuthGate';
import { HangarView } from '../components/HangarView';

export function MyHangarPage() {
  const me = useMe();
  return (
    <>
      <h1>My hangar</h1>
      <HangarView memberId={me.discordId} editable />
    </>
  );
}
