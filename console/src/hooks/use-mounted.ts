import { useEffect, useRef } from 'react';

// True while the component that asked is still on the page.
export function useMounted(): () => boolean {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return () => mounted.current;
}
