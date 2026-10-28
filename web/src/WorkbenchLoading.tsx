import { Skeleton } from "./Skeleton";
export function WorkbenchLoading({mode}:{mode:"code"|"terminal"}) {
  if(mode==="terminal")return <div className="workbench-loading"><Skeleton kind="code" rows={3} label="Starting terminal…"/></div>;
  return <div className="workbench-loading code-loading-layout"><aside><Skeleton kind="tree" rows={7} label="Loading file explorer…"/></aside><div><Skeleton kind="code" label="Loading Code editor…"/></div></div>;
}
