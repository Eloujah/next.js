/* __next_internal_action_entry_do_not_use__ $ACTION_deleteItem */ import deleteFromDb from 'db';
const v1 = 'v1';
export function Item({ id1 , id2  }) {
    const v2 = id2;
    async function deleteItem() {
        return $ACTION_deleteItem(deleteItem.$$bound);
    }
    deleteItem.$$typeof = Symbol.for("react.server.reference");
    deleteItem.$$id = "de52fdc8536c533b05b2e525bd43b18cf019cbb3";
    deleteItem.$$bound = [
        id1,
        v2
    ];
    return <Button action={deleteItem}>Delete</Button>;
}
export async function $ACTION_deleteItem(closure) {
    await deleteFromDb(closure[0]);
    await deleteFromDb(v1);
    await deleteFromDb(closure[1]);
}