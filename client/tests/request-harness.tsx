// Local-only Playwright harness. Uses the actual controller, crypto, panel and design styles.
import { createRoot } from 'react-dom/client';
import { RequestPanel } from '../src/ui/security/RequestFlow';
import { RequestingLink } from '../src/core/requestLink';
import { IdentityStorage } from '../src/transport/identityStorage';
import { Api } from '../src/transport/api';
import { b64u } from '../src/crypto/identity';
import { linkKeys,newEphemeral,parseQr } from '../src/crypto/link';
import { sharedSecret,unwrap } from '../src/crypto/common';
import '../src/ui/styles/index.css';
const api=new Api(location.origin);
const controller=new RequestingLink(location.origin,new IdentityStorage(),api,async (_origin,auth)=>{api.authenticate(auth);});
Object.assign(window,{qrHarness:{controller,claim(){const qr=unwrap(parseQr(controller.qr()!,'hcr1')),e=newEphemeral();const ss=sharedSecret(e.priv,qr.showingPub);const keys=linkKeys({...qr,direction:'hcr1',claimingPub:e.pub,sharedSecret:ss});return {ephemeral_pub:b64u(e.pub),claim_tag:b64u(keys.claimTag),device_name:'Test phone'};}}});
createRoot(document.getElementById('root')!).render(<RequestPanel controller={controller} onClose={()=>void controller.cancel()}/>);
