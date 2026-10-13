import { EditorialDiff } from "./EditorialDiff";
import { useEditorialDraftReviews } from "./useEditorialDraftReviews";
export function EditorialDraftReview({filePath}:{filePath:string}) {
  const state=useEditorialDraftReviews(filePath);
  return <section className="editorial-draft-review" aria-label="Review editorial proposal" data-testid="editorial-draft-review">
    {state.error?<p role="alert" className="editorial-panel__error">{state.error}</p>:null}
    {state.reviews.map(review=><article key={review.invocation.id}>
      <header><strong>Agent proposal</strong><span>{review.prior.title}</span></header>
      {review.proposal?.edits.map(edit=>{const target=review.proposal!.targets.find(target=>target.id===edit.targetId);return target?<EditorialDiff key={target.id} base={target.base} replacement={edit.replacement}/>:null;})}
      <details><summary>Agent response</summary><p className="editorial-panel__excerpt">{review.message}</p></details>
      <div className="editorial-panel__actions"><button type="button" disabled={!review.canKeep||state.pending!==null} onClick={()=>void state.decide(review.invocation.id,"keep")}>Keep draft</button><button type="button" disabled={!review.canReject||state.pending!==null} onClick={()=>void state.decide(review.invocation.id,"reject")}>Reject draft</button></div>
    </article>)}
  </section>;
}
