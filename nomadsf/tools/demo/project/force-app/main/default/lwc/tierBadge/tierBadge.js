import { LightningElement, api } from 'lwc';

export default class TierBadge extends LightningElement {
  @api tier;

  get label() {
    return this.tier ? `${this.tier} customer` : 'No tier';
  }

  get badgeClass() {
    return `slds-badge ${this.tier === 'Gold' ? 'slds-theme_warning' : ''}`;
  }
}
