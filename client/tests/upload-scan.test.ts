import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Api } from '../src/transport/api';
import { ResumableUpload, uploadScanMessage, type Upload, type UploadScan } from '../src/transport/uploads';
const scan = (reason: UploadScan['reason']): UploadScan => ({attempt_id:'attempt',engine:'clamav',verdict:'incomplete',reason,coverage:'engine_limited',bytes_consumed:'3',finished_at_ms:1});
const upload: Upload={id:'id',channel_id:'room',filename:'x',length:'3',offset:'3',status:'quarantined',scan:scan('engine_limit')};
describe('truthful scan outcome and existing release gates',()=>{
 it('reports engine limits and unclassified rejection without claiming malware or complete coverage',()=>{
  expect(uploadScanMessage(scan('engine_limit'))).toContain('analysis limit');
  expect(uploadScanMessage(scan('unclassified_rejection'))).toContain('without a classified verdict');
  expect(uploadScanMessage(scan('engine_reported_no_finding'))).toContain('coverage is not guaranteed');
  expect(uploadScanMessage(null)).toContain('No scan result');
 });
 it('refreshes persisted quarantine reason after actual API423 and retries only through the same complete endpoint',async()=>{
  const request=vi.fn().mockRejectedValueOnce(new ApiError(423,'quarantined')).mockResolvedValueOnce({...upload,status:'ready',scan:{...scan('engine_reported_no_finding'),verdict:'no_finding',coverage:'stream_consumed'}});
  const changed=vi.fn();const api={request,get:vi.fn().mockResolvedValue(upload)} as unknown as Api;
  const transport=new ResumableUpload(api,changed);
  await expect(transport.retryScan('id')).rejects.toThrow('analysis limit');
  expect(changed).toHaveBeenLastCalledWith(upload);
  await expect(transport.retryScan('id')).resolves.toMatchObject({status:'ready'});
  expect(request.mock.calls.map(call=>call[0])).toEqual(['/api/uploads/id/complete','/api/uploads/id/complete']);
 });
 it('a late scan-status response cannot reappear after pause/account cleanup',async()=>{
  let finish!:(upload:Upload)=>void;
  const get=vi.fn().mockReturnValue(new Promise<Upload>(resolve=>{finish=resolve;}));const changed=vi.fn();
  const transport=new ResumableUpload({get} as unknown as Api,changed);
  const result=transport.refreshScan('id');transport.pause();finish(upload);
  await expect(result).rejects.toMatchObject({name:'AbortError'});expect(changed).not.toHaveBeenCalled();
 });
});
