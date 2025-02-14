import { uintCV } from '@stacks/transactions';
import { SimulationBuilder } from '..';

const test = () => SimulationBuilder.new()
  .withSender('SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER')
  .inlineSimulation('1ab04a8d13d72a301b77b6af9d4f612b')
  .addContractDeploy({
    contract_name: 'test-simulation',
    source_code: `
;; counter example
(define-data-var counter uint u0)

(define-public (increment (delta uint))
  (begin
    (var-set counter (+ (var-get counter) delta))
    (ok (var-get counter))))

(define-public (decrement)
  (begin 
    (var-set counter (- (var-get counter) u1))
    (ok (var-get counter))))

(define-read-only (get-counter)
  (ok (var-get counter)))
`,
  })
  .addEvalCode(
    'SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER.test-simulation',
    '(get-counter)'
  )
  .addContractCall({
    contract_id: 'SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER.test-simulation',
    function_name: 'increment',
    function_args: [uintCV(10)],
  })
  .addEvalCode(
    'SP212Y5JKN59YP3GYG07K3S8W5SSGE4KH6B5STXER.test-simulation',
    '(get-counter)'
  )
  .run()

if (require.main === module) {
  ; (async () => {
    await test()
  })().catch(console.error);
}