import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorialDraftReviewPayload } from "../../../shared/api/invocation-commands";
export function useEditorialDraftReviews(filePath:string) {
  const [reviews,setReviews]=useState<EditorialDraftReviewPayload[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [pending,setPending]=useState<string|null>(null);
  const requestRef=useRef(0);
  const pathRef=useRef(filePath);pathRef.current=filePath;
  const refresh=useCallback(async()=>{
    const path=filePath;const request=++requestRef.current;
    try {const items=await window.exograph.workspace.listPendingEditorialDraftReviews();if(pathRef.current===path&&request===requestRef.current)setReviews(items.filter(item=>item.documentPath===path));}
    catch(error){if(pathRef.current===path&&request===requestRef.current)setError(error instanceof Error?error.message:String(error));}
  },[filePath]);
  useEffect(()=>{setReviews([]);setError(null);void refresh();const dispose=window.exograph.workspace.onInvocationActivity(()=>void refresh());const updated=window.exograph.workspace.onInvocationUpdated(()=>void refresh());return ()=>{requestRef.current++;dispose();updated();};},[refresh]);
  const decide=useCallback(async(invocationId:string,action:"keep"|"reject")=>{
    setPending(invocationId);setError(null);
    try {await window.exograph.workspace.reviewEditorialDraft({invocationId,action});await refresh();}
    catch(error){if(pathRef.current===filePath)setError(error instanceof Error?error.message:String(error));}
    finally {if(pathRef.current===filePath)setPending(null);}
  },[filePath,refresh]);
  return {reviews,error,pending,decide};
}
