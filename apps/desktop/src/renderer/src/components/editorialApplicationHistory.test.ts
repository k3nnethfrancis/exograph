import { describe, expect, it } from "vitest";
import { getEditorialApplicationHistory, recordEditorialApplication } from "./editorialApplicationHistory";
describe("paired annotation history",()=>{
  it("keeps a first inline application reachable when it creates stable document identity",()=>{
    const path=`/fixture/${crypto.randomUUID()}.md`,id=crypto.randomUUID();
    const receipt={id:"transaction",before:"Original + inline notes",after:"Original"};
    const history=recordEditorialApplication(path,id,receipt);
    expect(getEditorialApplicationHistory(id)).toBe(history);expect(getEditorialApplicationHistory(path)).toBe(history);
    history.index--;
    expect(getEditorialApplicationHistory(id)?.entries[history.index]).toEqual(receipt);
  });
  it("retains successive applications and drops redo only after a new explicit application",()=>{
    const id=crypto.randomUUID();const one={id:"one",before:"a",after:"b"},two={id:"two",before:"b",after:"c"};
    recordEditorialApplication(id,id,one);const history=recordEditorialApplication(id,id,two);history.index--;
    expect(history.entries[history.index]).toBe(two);
    const three={id:"three",before:"b",after:"d"};recordEditorialApplication(id,id,three);
    expect(history.entries).toEqual([one,three]);expect(history.index).toBe(2);
  });
});
