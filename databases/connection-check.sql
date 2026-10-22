\conninfo
begin read only;
select current_database() as database,
       current_user as database_user,
       current_setting('transaction_read_only') as read_only;
rollback;
