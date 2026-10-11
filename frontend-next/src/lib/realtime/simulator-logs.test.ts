import { describe, expect, it } from 'vitest';
import { appendSimulatorLog, MAX_SIMULATOR_LOG_ROWS, type SimulatorLogData } from './simulator-logs';
describe('simulator WS feed', () => {
  it('adds live entries and deduplicates broadcasts', () => {
    const event={timestamp:'2026-10-11T10:00:00Z',level:'info',message:'GETBULK'};
    const next=appendSimulatorLog({items:[]},event);
    expect(next.items).toEqual([event]);
    expect(appendSimulatorLog(next,{...event}).items).toHaveLength(1);
  });
  it('caps the chronological list to 200', () => {
    let feed: SimulatorLogData={items:[]};
    for(let i=0;i<215;i++) feed=appendSimulatorLog(feed,{timestamp:String(i),message:'GET'});
    expect(feed.items).toHaveLength(MAX_SIMULATOR_LOG_ROWS);
    expect(feed.items?.[0]?.timestamp).toBe('15');
  });
});
