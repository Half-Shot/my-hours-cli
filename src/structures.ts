interface Times {
    duration: number;
    startTime: string;
    endTime: string;
    running: boolean;
    id: number;
}

export interface MyHoursTag {
    name: string;
    hexColor: string;
    archived: boolean;
    dateArchived: string|null;
    id: number;
}

export interface MyHoursProject {
    name: string;
    archived: boolean;
    clientId: number|null;
    clientName: string|null;
    customId: string|null;
    id: number;
}

export interface MyHoursProjectTask {
    name: string;
    description: string|null;
    completed: boolean;
    archived: boolean;
    customId: string|null;
    id: number;
}

export interface MyHoursProjectTaskList {
    listName: string;
    listNo: number;
    completedTasks: MyHoursProjectTask[];
    incompletedTasks: MyHoursProjectTask[];
    archivedTasks: MyHoursProjectTask[];
}

export interface MyHoursTask {
    note: string;
    date: string;
    duration: number;
    projectName: string;
    taskName: string;
    clientName: string;
    projectInvoiceMethod: number;
    projectArchived: boolean;
    taskArchived: boolean;
    running: boolean;
    startTime: string;
    endTime: string;
    times: Array<Times>;
    status: number;
    invoiceId: number;
    projectId: number;
    taskId: number;
    billable: boolean;
    inLockedPeriod: boolean|null;
    expense: number;
    userId: number;
    amount: number;
    rate: number;
    laborCost: number;
    laborRate: number;
    billableDuration: number;
    billableHours: number;
    laborHours: number;
    tags: Array<MyHoursTag>;
    attachments: Array<unknown>;
    billableAmount: number;
    id: number;
}
