import { useState, useEffect } from "react";

export const useElapsed = (startTime: number): number => {
  const [elapsed, setElapsed] = useState(() => Date.now() - startTime);

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 1000);
    return () => clearInterval(id);
  }, [startTime]);

  return elapsed;
};
