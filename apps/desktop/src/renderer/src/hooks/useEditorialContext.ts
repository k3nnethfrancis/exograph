import { useCallback, useState } from "react";
import type { EditorialPaneController } from "../components/editorialTypes";
export function useEditorialContext() {
  const [barriers,setBarriers] = useState<Record<string,string>>({});
  const [controllers, setControllers] = useState<Record<string, EditorialPaneController>>({});
  const register = useCallback((paneId: string, controller: EditorialPaneController | null) => {
    setControllers(current => {
      if (current[paneId] === controller || !controller && !current[paneId]) return current;
      const next = {...current};
      if (controller) next[paneId] = controller; else delete next[paneId];
      return next;
    });
  }, []);
  const freeze = useCallback((paneId:string,filePath:string,enabled:boolean) => {
    setBarriers(current => {
      const key=`${paneId}\0${filePath}`;
      if(enabled && current[key]===filePath || !enabled && !current[key]) return current;
      const next={...current};if(enabled)next[key]=filePath;else delete next[key];return next;
    });
  }, []);
  return { controllers, register, freeze, frozenPaths:new Set(Object.values(barriers)) };
}
