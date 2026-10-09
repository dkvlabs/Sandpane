import { Button } from "./primitives";
import { IconRefresh } from "../layout/icons";
import { useCoreProbe } from "../../lib/hooks";

/** Single "ask Core again" control so retry paths stay consistent. */
export function useProbeRefetch(): () => void {
  const { refetch } = useCoreProbe();
  return refetch;
}

export function RefreshButton({ label = "Re-check Core" }: { label?: string }) {
  const refetch = useProbeRefetch();
  return (
    <Button onClick={refetch}>
      <IconRefresh /> {label}
    </Button>
  );
}
