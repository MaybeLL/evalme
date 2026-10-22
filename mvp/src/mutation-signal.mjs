import {setImmediate} from 'node:timers/promises';
import {AppError} from './config.mjs';
// Finish/roll back an in-flight transaction before reporting cancellation. During
// COMMIT the database's acknowledgement determines the result, not the signal.
export function mutationSignal() {
 let cancelled=false;
 const onSignal=()=>{cancelled=true;};
 process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
 return {
  async checkpoint(){await setImmediate();if(cancelled)throw new AppError('CANCELLED','已取消，事务未提交。',130);},
  close(){process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);},
 };
}
