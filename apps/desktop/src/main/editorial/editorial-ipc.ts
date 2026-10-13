import { handleDesktopInvoke } from '../typed-ipc';
import type { EditorialService } from './editorial-service';
export function registerEditorialIpcHandlers(service:EditorialService):void {
 handleDesktopInvoke('editorial:relink',(_event,path,id,revision)=>service.relink(path,id,revision));
 handleDesktopInvoke('editorial:read',(_event,path)=>service.read(path));
 handleDesktopInvoke('editorial:save',(_event,path,notes,revision)=>service.save(path,notes,revision));
 handleDesktopInvoke('editorial:apply',(_event,path,id,sourceRevision,revision)=>service.apply(path,id,sourceRevision,revision));
 handleDesktopInvoke('editorial:migrate',(_event,path,ids,sourceRevision,revision)=>service.migrate(path,ids,sourceRevision,revision));
 handleDesktopInvoke('editorial:undo',(_event,path,id,sourceRevision,revision)=>service.undo(path,id,sourceRevision,revision));
 handleDesktopInvoke('editorial:redo',(_event,path,id,sourceRevision,revision)=>service.redo(path,id,sourceRevision,revision));
}
