import { LightningElement, api, wire } from 'lwc';
import getInvoices from '@salesforce/apex/InvoiceController.getInvoices';

const COLUMNS = [
  { label: 'Invoice', fieldName: 'Name' },
  { label: 'Amount', fieldName: 'Amount__c', type: 'currency' },
  { label: 'Status', fieldName: 'Status__c' },
  { label: 'Due', fieldName: 'Due_Date__c', type: 'date' },
];

export default class AccountInvoices extends LightningElement {
  @api recordId;
  columns = COLUMNS;

  @wire(getInvoices, { accountId: '$recordId' })
  invoices;
}
